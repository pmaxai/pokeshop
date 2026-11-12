'use server';

import { redirect } from 'next/navigation';
import {
  deleteContactMessage,
  markContactUnread,
  setContactDone,
  setContactNotify,
} from '@pokeshop/core/contact';
import { db } from '@/server/config';
import { audit, requireAdmin } from '@/server/admin-auth';

const back = (path: string, notice: string): never =>
  redirect(`${path}${path.includes('?') ? '&' : '?'}ok=${encodeURIComponent(notice)}`);

const idOf = (f: FormData) => Number(f.get('id'));

/** The switch on Admin › Nachrichten: e-mail on every new message, or not. */
export async function contactNotifyAction(form: FormData) {
  const user = await requireAdmin();
  const on = form.get('on') === '1';
  await setContactNotify(db(), on);
  await audit(user, 'settings.update', 'setting', 'contact_notify', null, { on });
  back(
    '/admin/nachrichten',
    on ? 'E-Mail-Benachrichtigung ist an.' : 'E-Mail-Benachrichtigung ist aus.',
  );
}

export async function contactDoneAction(form: FormData) {
  const user = await requireAdmin();
  const id = idOf(form);
  const done = form.get('done') === '1';
  await setContactDone(db(), id, done, user.email);
  await audit(user, done ? 'contact.done' : 'contact.reopened', 'contact_message', id, null, null);
  if (done) back('/admin/nachrichten', 'Als erledigt markiert.');
  back(`/admin/nachrichten/${id}`, 'Wieder offen.');
}

export async function contactUnreadAction(form: FormData) {
  const user = await requireAdmin();
  const id = idOf(form);
  await markContactUnread(db(), id);
  await audit(user, 'contact.unread', 'contact_message', id, null, null);
  back('/admin/nachrichten', 'Als ungelesen markiert.');
}

export async function contactDeleteAction(form: FormData) {
  const user = await requireAdmin();
  const id = idOf(form);
  await deleteContactMessage(db(), id);
  await audit(user, 'contact.deleted', 'contact_message', id, null, null);
  back('/admin/nachrichten', 'Nachricht gelöscht.');
}
