import {
  contactCounts,
  contactNotify,
  listContactMessages,
  type ContactView,
} from '@pokeshop/core/contact';
import { db, getSetting } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import { contactNotifyAction } from '../contact-actions';
import { dateTime } from '../labels';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Nachrichten' };

const VIEWS: Record<ContactView, string> = { open: 'Offen', done: 'Erledigt', all: 'Alle' };

const preview = (s: string) => (s.length > 160 ? `${s.slice(0, 160).trimEnd()} …` : s);

export default async function Messages({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const view: ContactView = sp.view === 'done' || sp.view === 'all' ? sp.view : 'open';
  const [rows, counts, notify, recipients] = await Promise.all([
    listContactMessages(db(), view),
    contactCounts(db()),
    contactNotify(db()),
    getSetting<string[]>('admin_alert_recipients', []),
  ]);
  return (
    <AdminShell user={user} active="messages" notice={sp}>
      <h1>Nachrichten</h1>
      <form action={contactNotifyAction} className="notify-switch">
        <input type="hidden" name="on" value={notify ? '0' : '1'} />
        <button
          type="submit"
          role="switch"
          aria-checked={notify}
          aria-labelledby="notify-label"
          aria-describedby="notify-note"
          className="switch"
        >
          <span className="switch__knob" />
        </button>
        <span>
          <strong id="notify-label">E-Mail bei neuen Nachrichten</strong>
          <br />
          <span id="notify-note" className="muted">
            {notify
              ? `An: ${recipients.join(', ') || 'niemand eingetragen'}. Mit „Antworten“ im Mailprogramm schreibst du direkt dem Absender.`
              : 'Aus: Neue Nachrichten erscheinen nur hier.'}
            {user.role === 'owner' && (
              <>
                {' '}
                <a href="/admin/einstellungen">Empfänger ändern</a>
              </>
            )}
          </span>
        </span>
      </form>
      <nav className="tabs" aria-label="Ansicht">
        {(Object.keys(VIEWS) as ContactView[]).map((v) => (
          <a key={v} href={`?view=${v}`} aria-current={v === view ? 'page' : undefined}>
            {VIEWS[v]}
            {v === 'open' && <span className="tabs__n"> {counts.open}</span>}
          </a>
        ))}
      </nav>
      {rows.length === 0 ? (
        <p className="muted">
          {view === 'open'
            ? 'Keine offenen Nachrichten. Neue kommen über das Kontaktformular im Shop.'
            : 'Hier ist nichts.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table messages">
            <thead>
              <tr>
                <th>Eingang</th>
                <th>Von</th>
                <th>Nachricht</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const unread = !m.read_at && !m.done_at;
                return (
                  <tr key={m.id} className={unread ? 'messages__unread' : undefined}>
                    <td>{dateTime(m.created_at)}</td>
                    <td>
                      {m.name}
                      <br />
                      <span className="muted">{m.email}</span>
                    </td>
                    <td>
                      <a href={`/admin/nachrichten/${m.id}`}>{m.subject || 'Ohne Betreff'}</a>
                      <br />
                      <span className="muted">{preview(m.message)}</span>
                    </td>
                    <td>
                      {m.done_at ? (
                        <span className="pill pill--active">erledigt</span>
                      ) : unread ? (
                        <span className="pill pill--draft">neu</span>
                      ) : (
                        <span className="pill">gelesen</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        Erledigte Nachrichten werden nach zwölf Monaten automatisch gelöscht.
      </p>
    </AdminShell>
  );
}
