import { adminEvents } from '@pokeshop/core/events';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import { dateTime } from '../labels';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Veranstaltungen' };

export default async function Events({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const rows = await adminEvents(db());
  const now = Date.now();
  return (
    <AdminShell user={user} active="events" notice={await searchParams}>
      <h1>Veranstaltungen</h1>
      <p className="toolbar">
        <a className="btn btn--accent" href="/admin/veranstaltungen/neu">
          Neue Veranstaltung
        </a>
        <a href="/veranstaltungen" target="_blank" rel="noreferrer">
          Seite im Shop ansehen
        </a>
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Beginn</th>
              <th>Titel</th>
              <th>Ort</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr
                key={e.id}
                className={new Date(e.ends_at ?? e.starts_at).getTime() < now ? 'past' : undefined}
              >
                <td>{dateTime(e.starts_at)}</td>
                <td>
                  <a href={`/admin/veranstaltungen/${e.id}`}>{e.title_de}</a>
                </td>
                <td>
                  {e.venue ? `${e.venue}, ` : ''}
                  {e.city}
                </td>
                <td>{e.status === 'published' ? 'veröffentlicht' : 'Entwurf'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Noch keine Veranstaltungen.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
