import { notFound } from 'next/navigation';
import { openContactMessage } from '@pokeshop/core/contact';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../../AdminShell';
import { contactDeleteAction, contactDoneAction, contactUnreadAction } from '../../contact-actions';
import { dateTime } from '../../labels';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Nachricht' };

export default async function Message({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  // Opening the message marks it as read.
  const m = await openContactMessage(db(), id);
  if (!m) notFound();
  const sp = await searchParams;
  const subject = m.subject || 'Ihre Nachricht';
  const reply = `mailto:${m.email}?subject=${encodeURIComponent(`Re: ${subject}`)}`;
  return (
    <AdminShell user={user} active="messages" notice={sp}>
      <p>
        <a href="/admin/nachrichten">← Alle Nachrichten</a>
      </p>
      <h1>{m.subject || 'Ohne Betreff'}</h1>
      <dl className="message-meta">
        <dt>Von</dt>
        <dd>
          {m.name} · <a href={`mailto:${m.email}`}>{m.email}</a>
        </dd>
        <dt>Eingang</dt>
        <dd>
          {dateTime(m.created_at)} · Kontaktformular, {m.locale === 'de' ? 'Deutsch' : 'Englisch'}
        </dd>
        <dt>Status</dt>
        <dd>{m.done_at ? `erledigt am ${dateTime(m.done_at)} von ${m.done_by}` : 'offen'}</dd>
      </dl>
      <div className="message-body">{m.message}</div>
      <div className="message-actions">
        <a className="btn btn--accent" href={reply}>
          Antworten
        </a>
        <form action={contactDoneAction}>
          <input type="hidden" name="id" value={m.id} />
          <input type="hidden" name="done" value={m.done_at ? '0' : '1'} />
          <button type="submit" className="btn">
            {m.done_at ? 'Wieder öffnen' : 'Als erledigt markieren'}
          </button>
        </form>
        {!m.done_at && (
          <form action={contactUnreadAction}>
            <input type="hidden" name="id" value={m.id} />
            <button type="submit" className="btn btn--quiet">
              Als ungelesen markieren
            </button>
          </form>
        )}
      </div>
      <details className="message-delete">
        <summary>Löschen …</summary>
        <form action={contactDeleteAction}>
          <input type="hidden" name="id" value={m.id} />
          <p className="muted">Die Nachricht ist danach weg, auch aus dem Verlauf.</p>
          <button type="submit" className="btn btn--danger">
            Endgültig löschen
          </button>
        </form>
      </details>
    </AdminShell>
  );
}
