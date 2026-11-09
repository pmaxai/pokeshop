'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { refundLicenseOrder, resendOrderLicenses, saveAppSettings } from '@pokeshop/core/licenses';
import { euroToCents } from '@pokeshop/core/shop-settings';
import { db } from '@/server/config';
import { audit, requireAdmin } from '@/server/admin-auth';
import { paymentsForOrder } from '@/server/payments';

const back = (path: string, notice: string, kind: 'ok' | 'err' = 'ok'): never =>
  redirect(`${path}?${kind}=${encodeURIComponent(notice)}`);

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

/** Admin › App: price and the Play Store link (which replaces the APK download). */
export async function saveAppSettingsAction(form: FormData) {
  const user = await requireAdmin('owner');
  let price: number | null = null;
  try {
    price = euroToCents(str(form, 'price'));
  } catch {
    price = null;
  }
  const playStoreUrl = str(form, 'play_store_url');
  const senderEmail = str(form, 'sender_email') || undefined;
  try {
    if (price === null || price < 100) throw new Error('price');
    if (senderEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) throw new Error('email');
    await saveAppSettings(db(), { priceCents: price, playStoreUrl, senderEmail });
    await audit(user, 'app.settings', 'settings', 'app', null, {
      price,
      playStoreUrl,
      senderEmail,
    });
  } catch (e) {
    const m = (e as Error).message;
    back(
      '/admin/app',
      m === 'price'
        ? 'Bitte einen Preis in Euro angeben, z. B. 139,00.'
        : m === 'email'
          ? 'Bitte eine gültige Absender-Adresse angeben.'
          : 'Der Play-Store-Link muss so aussehen: https://play.google.com/store/apps/details?id=…',
      'err',
    );
  }
  revalidatePath('/', 'layout');
  back('/admin/app', 'Gespeichert.');
}

export async function resendLicenseMailAction(form: FormData) {
  const user = await requireAdmin();
  const id = Number(str(form, 'id'));
  const path = `/admin/bestellungen/${id}`;
  try {
    await resendOrderLicenses(db(), id, user.email);
    await audit(user, 'license.resend', 'order', id, null, null);
  } catch (e) {
    back(path, (e as Error).message, 'err');
  }
  back(path, 'Die Lizenz-E-Mail geht in den nächsten Minuten noch einmal raus.');
}

export async function refundLicenseAction(form: FormData) {
  const user = await requireAdmin('owner');
  const id = Number(str(form, 'id'));
  const path = `/admin/bestellungen/${id}`;
  if (str(form, 'confirm') !== 'on') back(path, 'Bitte die Erstattung bestätigen.', 'err');
  // GmbH orders go back through the GmbH's Stripe account (with its credit note).
  const provider = await paymentsForOrder(id);
  if (!provider) back(path, 'Das Stripe-Konto dieser Bestellung ist nicht eingerichtet.', 'err');
  let message = '';
  try {
    const r = await refundLicenseOrder(db(), provider!, {
      orderId: id,
      actor: user.email,
      reason: str(form, 'reason'),
    });
    message = `${(r.amount / 100).toFixed(2).replace('.', ',')} € erstattet, Lizenz wird gesperrt${r.creditNote ? `, Gutschrift ${r.creditNote}` : ''}.`;
    await audit(user, 'license.refund', 'order', id, null, r);
  } catch (e) {
    back(path, (e as Error).message || 'Erstattung fehlgeschlagen.', 'err');
  }
  back(path, message);
}
