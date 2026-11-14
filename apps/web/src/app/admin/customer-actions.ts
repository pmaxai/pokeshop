'use server';

import { redirect } from 'next/navigation';
import { endDevice } from '@pokeshop/core/devices';
import { accountById } from '@pokeshop/core/accounts';
import {
  ChangeRejected,
  endComplimentary,
  grantComplimentary,
  saveSubscriptionPrices,
  setCancelAtPeriodEnd,
  setWebshopHost,
} from '@pokeshop/core/subscriptions';
import { db } from '@/server/config';
import { audit, requireAdmin } from '@/server/admin-auth';
import { billing } from '@/server/billing';

const back = (path: string, notice: string, err = false): never =>
  redirect(
    `${path}${path.includes('?') ? '&' : '?'}${err ? 'err' : 'ok'}=${encodeURIComponent(notice)}`,
  );

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const idOf = (f: FormData) => Number(str(f, 'id'));
const page = (id: number) => `/admin/kunden/${id}`;

export async function grantComplimentaryAction(form: FormData) {
  const user = await requireAdmin('owner');
  const id = idOf(form);
  const input = {
    plan: str(form, 'plan') === 'creator' ? ('creator' as const) : ('collector' as const),
    extraDevices: Number(str(form, 'extraDevices') || '0'),
    until: str(form, 'until'),
    note: str(form, 'note'),
  };
  try {
    await grantComplimentary(db(), id, input, user.email);
  } catch (e) {
    if (e instanceof ChangeRejected) {
      back(page(id), 'Es läuft ein bezahltes Abo. Erst kündigen (Stripe), dann verschenken.', true);
    }
    back(page(id), `Nicht gespeichert: ${(e as Error).message}`, true);
  }
  await audit(user, 'subscription.complimentary', 'account', id, null, input);
  back(page(id), 'Gratis-Abo gespeichert.');
}

export async function endComplimentaryAction(form: FormData) {
  const user = await requireAdmin('owner');
  const id = idOf(form);
  await endComplimentary(db(), id);
  await audit(user, 'subscription.complimentary_end', 'account', id, null, null);
  back(page(id), 'Gratis-Abo beendet.');
}

/** Paid subscription: cancel at the end of the paid month (or take that back). */
export async function adminCancelAction(form: FormData) {
  const user = await requireAdmin('owner');
  const id = idOf(form);
  const account = await accountById(db(), id);
  const b = billing();
  if (!account || !b) back(page(id), 'Stripe ist nicht eingerichtet.', true);
  const cancel = str(form, 'resume') !== '1';
  try {
    await setCancelAtPeriodEnd(db(), b!, account!, cancel);
  } catch (e) {
    back(page(id), `Stripe: ${(e as Error).message}`, true);
  }
  await audit(
    user,
    cancel ? 'subscription.cancel' : 'subscription.resume',
    'account',
    id,
    null,
    null,
  );
  back(page(id), cancel ? 'Abo endet zum Ende des bezahlten Monats.' : 'Abo läuft weiter.');
}

export async function webshopHostAction(form: FormData) {
  const user = await requireAdmin('owner');
  const id = idOf(form);
  const host = str(form, 'host');
  try {
    await setWebshopHost(db(), id, host || null);
  } catch {
    back(page(id), 'Bitte nur den Hostnamen eintragen, z. B. shop.example.com.', true);
  }
  await audit(user, 'account.webshop', 'account', id, null, { host: host || null });
  back(
    page(id),
    host
      ? `Webshop ${host} verbunden: Der Webshop-Modus ist in der App frei.`
      : 'Webshop getrennt.',
  );
}

export async function adminRemoveDeviceAction(form: FormData) {
  const user = await requireAdmin();
  const id = idOf(form);
  const device = str(form, 'device');
  await endDevice(db(), id, device, 'removed');
  await audit(user, 'device.removed', 'account', id, null, { device });
  back(page(id), 'Gerät entfernt.');
}

export async function adminNoteAction(form: FormData) {
  const user = await requireAdmin();
  const id = idOf(form);
  const note = str(form, 'note').slice(0, 2000);
  await db()`UPDATE accounts SET admin_note = ${note || null} WHERE id = ${id}`;
  await audit(user, 'account.note', 'account', id, null, null);
  back(page(id), 'Notiz gespeichert.');
}

const euroToCents = (v: string): number | null => {
  if (!v) return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

export async function savePricesAction(form: FormData) {
  const user = await requireAdmin('owner');
  const input = {
    collector: euroToCents(str(form, 'collector')),
    creator: euroToCents(str(form, 'creator')),
    collector_device: euroToCents(str(form, 'collector_device')),
    creator_device: euroToCents(str(form, 'creator_device')),
    s3_gb: euroToCents(str(form, 's3_gb')),
    pipeline_minute: euroToCents(str(form, 'pipeline_minute')),
  };
  try {
    const saved = await saveSubscriptionPrices(db(), input);
    await audit(user, 'settings.update', 'setting', 'subscription_prices', null, saved);
  } catch {
    back('/admin/kunden/preise', 'Bitte gültige Preise eintragen (mindestens 0,50 €).', true);
  }
  back('/admin/kunden/preise', 'Preise gespeichert. Sie gelten für neue Abos und Änderungen.');
}
