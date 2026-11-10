'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { cancelGiftVoucher } from '@pokeshop/core/gift-vouchers';
import { euroToCents } from '@pokeshop/core/shop-settings';
import {
  createDiscountCodes,
  createPromoVouchers,
  DiscountCodeTaken,
  setDiscountCodeActive,
  setVoucherBlocked,
} from '@pokeshop/core/vouchers';
import { db } from '@/server/config';
import { audit, requireAdmin } from '@/server/admin-auth';
import { payments } from '@/server/payments';

const back = (path: string, notice: string, kind: 'ok' | 'err' = 'ok'): never =>
  redirect(`${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(notice)}`);

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const cents = (v: string) => {
  try {
    return v ? euroToCents(v) : null;
  } catch {
    return null;
  }
};
/** A date field (YYYY-MM-DD) as the end of that day in Vienna, or its start. */
const day = (v: string, end: boolean) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${end ? '23:59:59' : '00:00:00'}+01:00`) : null;

/** Promotional vouchers: one for a friend, or a batch for an event. */
export async function createPromoVouchersAction(form: FormData) {
  const user = await requireAdmin('owner');
  const value = cents(str(form, 'value'));
  const count = Number(str(form, 'count') || 1);
  if (!value || value < 100) back('/admin/gutscheine', 'Bitte einen Wert in Euro angeben.', 'err');
  let created: { id: number; code: string }[] = [];
  try {
    created = await createPromoVouchers(
      db(),
      {
        valueCents: value!,
        count,
        expiresAt: day(str(form, 'expires'), true),
        note: str(form, 'note'),
        recipientName: str(form, 'recipient'),
        message: str(form, 'message'),
      },
      user.email,
    );
    await audit(user, 'voucher.promo_create', 'voucher', created[0]?.id ?? 0, null, {
      value,
      count,
      note: str(form, 'note'),
    });
  } catch (e) {
    back('/admin/gutscheine', `Nicht angelegt: ${(e as Error).message}`, 'err');
  }
  revalidatePath('/admin/gutscheine');
  if (created.length === 1) {
    back(`/admin/gutscheine/${created[0]!.id}`, `Gutschein ${created[0]!.code} angelegt.`);
  }
  back(
    `/admin/gutscheine?origin=promo&created=${created.map((c) => c.id).join(',')}`,
    `${created.length} Gutscheine angelegt.`,
  );
}

export async function blockVoucherAction(form: FormData) {
  const user = await requireAdmin('owner');
  const id = Number(str(form, 'id'));
  const blocked = str(form, 'blocked') === '1';
  await setVoucherBlocked(db(), id, blocked);
  await audit(user, blocked ? 'voucher.block' : 'voucher.unblock', 'voucher', id, null, null);
  revalidatePath(`/admin/gutscheine/${id}`);
  back(`/admin/gutscheine/${id}`, blocked ? 'Gutschein gesperrt.' : 'Gutschein wieder aktiv.');
}

/** A bought voucher taken back (withdrawal): refund through Stripe. */
export async function cancelVoucherAction(form: FormData) {
  const user = await requireAdmin('owner');
  const id = Number(str(form, 'id'));
  const path = `/admin/gutscheine/${id}`;
  if (str(form, 'confirm') !== 'on') back(path, 'Bitte die Stornierung bestätigen.', 'err');
  const provider = payments('shop');
  if (!provider) back(path, 'Stripe ist nicht eingerichtet.', 'err');
  let amount = 0;
  try {
    amount = (
      await cancelGiftVoucher(db(), provider!, {
        voucherId: id,
        actor: user.email,
        reason: str(form, 'reason'),
      })
    ).amount;
    await audit(user, 'voucher.cancel', 'voucher', id, null, { amount });
  } catch (e) {
    back(path, (e as Error).message, 'err');
  }
  revalidatePath(path);
  back(path, `Gutschein storniert, ${(amount / 100).toFixed(2).replace('.', ',')} € erstattet.`);
}

/** A discount code, or a batch of single-use codes. */
export async function createDiscountCodesAction(form: FormData) {
  const user = await requireAdmin('owner');
  const path = '/admin/rabattcodes';
  const kind = str(form, 'kind') === 'amount' ? 'amount' : 'percent';
  const percent = Number(str(form, 'percent').replace(',', '.'));
  const count = Number(str(form, 'count') || 1);
  const maxUses = str(form, 'max_uses');
  const maxLicenses = str(form, 'max_licenses');
  let created: { id: number; code: string }[] = [];
  try {
    created = await createDiscountCodes(
      db(),
      {
        code: count > 1 ? undefined : str(form, 'code') || undefined,
        count,
        prefix: count > 1 ? str(form, 'prefix') || undefined : undefined,
        campaign: str(form, 'campaign') || undefined,
        kind,
        percentBp: kind === 'percent' && percent > 0 ? Math.round(percent * 100) : undefined,
        amountCents: kind === 'amount' ? (cents(str(form, 'amount')) ?? undefined) : undefined,
        appliesTo:
          (['cards', 'licenses', 'both'] as const).find((a) => a === str(form, 'applies_to')) ??
          'cards',
        minGoodsCents: cents(str(form, 'min_goods')) ?? 0,
        maxLicenses: maxLicenses ? Number(maxLicenses) : null,
        maxUses: maxUses ? Number(maxUses) : null,
        oncePerCustomer: str(form, 'once') === 'on',
        validFrom: day(str(form, 'valid_from'), false),
        validUntil: day(str(form, 'valid_until'), true),
        note: str(form, 'note') || undefined,
      },
      user.email,
    );
    await audit(user, 'discount_code.create', 'discount_code', created[0]?.id ?? 0, null, {
      codes: created.length,
      first: created[0]?.code,
      campaign: str(form, 'campaign'),
    });
  } catch (e) {
    if (e instanceof DiscountCodeTaken) back(path, `Den Code ${e.code} gibt es schon.`, 'err');
    const issues = (e as { issues?: { message: string; path: (string | number)[] }[] }).issues;
    const msg = issues?.length
      ? issues
          .map((i) =>
            i.message === 'value'
              ? 'Bitte Prozent oder Betrag angeben.'
              : i.message === 'prefix'
                ? 'Für mehrere Codes bitte ein Präfix angeben (2–12 Buchstaben oder Ziffern).'
                : i.message === 'code'
                  ? 'Bitte einen Code angeben (3–40 Zeichen: Buchstaben, Ziffern, - und _).'
                  : i.message === 'dates'
                    ? '„Gültig bis“ muss nach „Gültig ab“ liegen.'
                    : `${i.path.join('.')}: ${i.message}`,
          )
          .join(' ')
      : (e as Error).message;
    back(path, `Nicht angelegt: ${msg}`, 'err');
  }
  revalidatePath(path);
  back(
    created.length > 1 ? `${path}?campaign=${encodeURIComponent(str(form, 'campaign'))}` : path,
    created.length > 1 ? `${created.length} Codes angelegt.` : `Code ${created[0]!.code} angelegt.`,
  );
}

export async function toggleDiscountCodeAction(form: FormData) {
  const user = await requireAdmin('owner');
  const ids = str(form, 'ids')
    .split(',')
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  const active = str(form, 'active') === '1';
  await setDiscountCodeActive(db(), ids, active);
  await audit(
    user,
    active ? 'discount_code.activate' : 'discount_code.deactivate',
    'discount_code',
    ids[0] ?? 0,
    null,
    { ids },
  );
  revalidatePath('/admin/rabattcodes');
  const back_ = str(form, 'back') || '/admin/rabattcodes';
  back(back_, active ? 'Wieder aktiv.' : 'Deaktiviert – der Code wirkt nicht mehr.');
}
