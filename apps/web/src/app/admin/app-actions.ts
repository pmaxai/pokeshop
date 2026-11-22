'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { saveAppSettings } from '@pokeshop/core/app';
import { db } from '@/server/config';
import { audit, requireAdmin } from '@/server/admin-auth';

const back = (path: string, notice: string, kind: 'ok' | 'err' = 'ok'): never =>
  redirect(`${path}?${kind}=${encodeURIComponent(notice)}`);

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

/** Admin › App: the store links (app page, devices page) and the GmbH's sender address. */
export async function saveAppSettingsAction(form: FormData) {
  const user = await requireAdmin('owner');
  const playStoreUrl = str(form, 'play_store_url');
  const appStoreUrl = str(form, 'app_store_url');
  const senderEmail = str(form, 'sender_email') || undefined;
  try {
    if (senderEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) throw new Error('email');
    await saveAppSettings(db(), { playStoreUrl, appStoreUrl, senderEmail });
    await audit(user, 'app.settings', 'settings', 'app', null, {
      playStoreUrl,
      appStoreUrl,
      senderEmail,
    });
  } catch (e) {
    const m = (e as Error).message;
    back(
      '/admin/app',
      m === 'email'
        ? 'Bitte eine gültige Absender-Adresse angeben.'
        : m.includes('app_store_url')
          ? 'Der App-Store-Link muss so aussehen: https://apps.apple.com/at/app/…/id123456789'
          : 'Der Play-Store-Link muss so aussehen: https://play.google.com/store/apps/details?id=…',
      'err',
    );
  }
  revalidatePath('/', 'layout');
  back('/admin/app', 'Gespeichert.');
}
