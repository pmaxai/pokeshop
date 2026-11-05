import { listApiClients } from '@pokeshop/core/api-clients';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import { revokeApiKey } from '../actions';
import { CreateKeyForm } from './CreateKeyForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'API-Schlüssel' };

const time = (d: Date | null) =>
  d
    ? new Intl.DateTimeFormat('de-AT', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: 'Europe/Vienna',
      }).format(new Date(d))
    : '–';

export default async function ApiKeys({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireAdmin('owner');
  const clients = await listApiClients(db());
  return (
    <AdminShell user={user} active="keys" notice={await searchParams}>
      <h1>API-Schlüssel</h1>
      <p style={{ marginBottom: 'var(--s-4)' }}>
        Die Scanner-App meldet sich mit einem Schlüssel an. Das Geheimnis wird nur einmal beim
        Anlegen angezeigt.
      </p>
      <CreateKeyForm />
      <h2>Vorhandene Schlüssel</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Schlüssel-ID</th>
              <th>Erlaubte IPs</th>
              <th>Zuletzt benutzt</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.key_id}</td>
                <td>{c.ip_allowlist.length ? c.ip_allowlist.join(', ') : 'alle'}</td>
                <td>{time(c.last_used_at)}</td>
                <td>
                  {c.revoked_at ? (
                    `gesperrt ${time(c.revoked_at)}`
                  ) : (
                    <span className="pill pill--active">aktiv</span>
                  )}
                </td>
                <td>
                  {!c.revoked_at && (
                    <form action={revokeApiKey}>
                      <input type="hidden" name="id" value={c.id} />
                      <button className="btn btn--quiet" type="submit">
                        Sperren
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
