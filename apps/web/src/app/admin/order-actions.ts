'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  FulfilmentError,
  markShipped,
  markWithdrawalHandled,
  refundOrder,
  saveInternalNote,
  startPacking,
} from '@pokeshop/core/fulfilment';
import { deleteEvent, EventInput, saveEvent } from '@pokeshop/core/events';
import {
  euroToCents,
  saveGeneralSettings,
  SettingsError,
  updateCountries,
  type CountryUpdate,
} from '@pokeshop/core/shop-settings';
import { enqueueJob } from '@pokeshop/core/jobs';
import { db } from '@/server/config';
import { audit, requireAdmin } from '@/server/admin-auth';
import { payments } from '@/server/payments';

const back = (path: string, notice: string, kind: 'ok' | 'err' = 'ok'): never =>
  redirect(`${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(notice)}`);

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

const idsOf = (f: FormData) =>
  f
    .getAll('order')
    .map((v) => Number(v))
    .filter((n) => Number.isSafeInteger(n) && n > 0);

/** Prints the pick list for the chosen paid orders and moves them to "packing". */
export async function packAction(form: FormData) {
  const user = await requireAdmin();
  const ids = idsOf(form);
  if (ids.length === 0)
    back('/admin/bestellungen', 'Bitte mindestens eine Bestellung auswählen.', 'err');
  await startPacking(db(), ids, user.email);
  revalidatePath('/admin', 'layout');
  redirect(`/admin/packliste?ids=${ids.join(',')}`);
}

export async function shipAction(form: FormData) {
  const user = await requireAdmin();
  const id = Number(str(form, 'id'));
  const path = `/admin/bestellungen/${id}`;
  let invoice: string | null = null;
  try {
    ({ invoice } = await markShipped(db(), id, {
      trackingNumber: str(form, 'tracking'),
      actor: user.email,
    }));
  } catch (e) {
    back(
      path,
      e instanceof FulfilmentError ? e.message : 'Versand konnte nicht gespeichert werden.',
      'err',
    );
  }
  await audit(user, 'order.ship', 'order', id, null, { tracking: str(form, 'tracking'), invoice });
  revalidatePath('/admin', 'layout');
  back(
    path,
    invoice
      ? `Versendet. Rechnung ${invoice} geht mit der Versandbestätigung an den Kunden.`
      : 'Versendet.',
  );
}

export async function refundAction(form: FormData) {
  const user = await requireAdmin('owner');
  const id = Number(str(form, 'id'));
  const path = `/admin/bestellungen/${id}`;
  if (str(form, 'confirm') !== 'on') back(path, 'Bitte die Erstattung bestätigen.', 'err');
  const provider = payments();
  if (!provider) back(path, 'Stripe ist nicht eingerichtet.', 'err');
  const items: { orderItemId: number; quantity: number; restock: boolean }[] = [];
  for (const [k, v] of form.entries()) {
    const m = /^qty_(\d+)$/.exec(k);
    if (m && typeof v === 'string' && Number(v) > 0) {
      items.push({
        orderItemId: Number(m[1]),
        quantity: Number(v),
        restock: form.get(`restock_${m[1]}`) === 'on',
      });
    }
  }
  let message = '';
  try {
    const r = await refundOrder(db(), provider!, {
      orderId: id,
      items,
      shipping: str(form, 'shipping') === 'on',
      reason: str(form, 'reason'),
      actor: user.email,
    });
    message = `${(r.amount / 100).toFixed(2).replace('.', ',')} € erstattet${r.creditNote ? `, Rechnungskorrektur ${r.creditNote}` : ''}.`;
    await audit(user, 'order.refund', 'order', id, null, { ...r, items });
  } catch (e) {
    back(path, e instanceof FulfilmentError ? e.message : 'Erstattung fehlgeschlagen.', 'err');
  }
  revalidatePath('/admin', 'layout');
  back(path, message);
}

export async function noteAction(form: FormData) {
  const user = await requireAdmin();
  const id = Number(str(form, 'id'));
  await saveInternalNote(db(), id, str(form, 'note'), user.email);
  back(`/admin/bestellungen/${id}`, 'Notiz gespeichert.');
}

export async function renderDocumentAction(form: FormData) {
  await requireAdmin();
  const id = Number(str(form, 'document'));
  const order = Number(str(form, 'id'));
  await enqueueJob(
    db(),
    'document.render',
    { document_id: id },
    { dedupeKey: `document.render:${id}` },
  );
  back(`/admin/bestellungen/${order}`, 'Das PDF wird erstellt – in ein paar Sekunden neu laden.');
}

export async function withdrawalHandledAction(form: FormData) {
  const user = await requireAdmin();
  const id = Number(str(form, 'id'));
  await markWithdrawalHandled(db(), id, user.email, str(form, 'note'));
  await audit(user, 'withdrawal.handled', 'withdrawal', id, null, { note: str(form, 'note') });
  back('/admin/widerrufe', 'Als erledigt markiert.');
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const EVENT_FIELDS = [
  'title_de',
  'title_en',
  'starts_at',
  'ends_at',
  'venue',
  'street',
  'postcode',
  'city',
  'country',
  'description_de',
  'description_en',
  'entry_fee',
  'table_info',
  'website_url',
  'status',
] as const;

const EVENT_ERRORS: Record<string, string> = {
  required: 'Pflichtfeld',
  too_long: 'zu lang',
  invalid_date: 'Datum und Uhrzeit angeben',
  before_start: 'Ende liegt vor dem Beginn',
  invalid_url: 'Adresse muss mit http:// oder https:// beginnen',
  invalid: 'ungültig',
};

export async function saveEventAction(form: FormData) {
  const user = await requireAdmin();
  const idRaw = str(form, 'id');
  const id = idRaw ? Number(idRaw) : null;
  const raw = Object.fromEntries(EVENT_FIELDS.map((k) => [k, str(form, k)]));
  const v = EventInput.safeParse({
    ...raw,
    status: str(form, 'status') === 'published' ? 'published' : 'draft',
  });
  const path = id ? `/admin/veranstaltungen/${id}` : '/admin/veranstaltungen/neu';
  if (!v.success) {
    const msg = v.error.issues
      .map((i) => `${i.path.join('.')}: ${EVENT_ERRORS[i.message] ?? i.message}`)
      .join('; ');
    back(path, `Nicht gespeichert – ${msg}`, 'err');
  }
  const saved = await saveEvent(db(), id, v.data!);
  await audit(user, id ? 'event.update' : 'event.create', 'event', saved, null, v.data);
  revalidatePath('/', 'layout');
  back(`/admin/veranstaltungen/${saved}`, 'Gespeichert.');
}

export async function deleteEventAction(form: FormData) {
  const user = await requireAdmin();
  const id = Number(str(form, 'id'));
  if (str(form, 'confirm') !== 'on')
    back(`/admin/veranstaltungen/${id}`, 'Bitte das Löschen bestätigen.', 'err');
  await deleteEvent(db(), id);
  await audit(user, 'event.delete', 'event', id, null, null);
  revalidatePath('/', 'layout');
  back('/admin/veranstaltungen', 'Veranstaltung gelöscht.');
}

// ---------------------------------------------------------------------------
// Settings (owner only)
// ---------------------------------------------------------------------------

const percentToBp = (v: string) => {
  const n = Number(v.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100)
    throw new SettingsError(`Prozentsatz „${v}“ nicht verstanden`);
  return Math.round(n * 100);
};

export async function saveCountriesAction(form: FormData) {
  const user = await requireAdmin('owner');
  try {
    const codes = form.getAll('code').map(String);
    const rows: CountryUpdate[] = codes.map((code) => ({
      code,
      deliveryEnabled: form.get(`enabled_${code}`) === 'on',
      minOrderCents: euroToCents(str(form, `min_${code}`)) ?? 0,
      insuredRateBp: percentToBp(str(form, `rate_${code}`) || '0'),
      insuredMinimumCents: euroToCents(str(form, `insmin_${code}`)) ?? 0,
      insuredMaxOrderCents: euroToCents(str(form, `insmax_${code}`)),
      deliveryTimeDe: str(form, `time_de_${code}`) || null,
      deliveryTimeEn: str(form, `time_en_${code}`) || null,
    }));
    await updateCountries(db(), rows);
    await audit(
      user,
      'settings.countries',
      'settings',
      'countries',
      null,
      rows.filter((r) => r.deliveryEnabled),
    );
  } catch (e) {
    back(
      '/admin/einstellungen',
      e instanceof SettingsError ? e.message : 'Nicht gespeichert.',
      'err',
    );
  }
  revalidatePath('/', 'layout');
  back('/admin/einstellungen', 'Lieferländer gespeichert.');
}

export async function saveSettingsAction(form: FormData) {
  const user = await requireAdmin('owner');
  try {
    const input = {
      high_value_threshold_cents: euroToCents(str(form, 'threshold')),
      reservation_minutes: Number(str(form, 'reservation')),
      admin_alert_recipients: str(form, 'recipients')
        .split(/[\s,;]+/)
        .filter(Boolean),
      tracking_url: str(form, 'tracking_url'),
    };
    await saveGeneralSettings(db(), input);
    await audit(user, 'settings.general', 'settings', 'general', null, input);
  } catch (e) {
    back(
      '/admin/einstellungen',
      e instanceof SettingsError ? e.message : 'Nicht gespeichert.',
      'err',
    );
  }
  revalidatePath('/', 'layout');
  back('/admin/einstellungen', 'Einstellungen gespeichert.');
}
