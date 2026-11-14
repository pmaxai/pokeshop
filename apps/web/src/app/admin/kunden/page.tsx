import { formatEuro } from '@pokeshop/core';
import { listCustomers, subscriptionCounts } from '@pokeshop/core/subscriptions';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import { dateTime, subscriptionStatusLabel as statusLabel } from '../labels';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Kunden & Abos' };

const FILTERS = { all: 'Alle', subscribed: 'Mit Abo', free: 'Ohne Abo' } as const;
const PLAN = { collector: 'Collector', creator: 'Creator' } as const;

export default async function Customers({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; f?: string; ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const filter = sp.f === 'subscribed' || sp.f === 'free' ? sp.f : 'all';
  const [rows, counts] = await Promise.all([
    listCustomers(db(), { query: sp.q, filter }),
    subscriptionCounts(db()),
  ]);
  return (
    <AdminShell user={user} active="customers" notice={sp}>
      <h1>Kunden & Abos</h1>
      <dl className="stats">
        <div>
          <dt>Collector</dt>
          <dd>{counts.collector}</dd>
        </div>
        <div>
          <dt>Creator</dt>
          <dd>{counts.creator}</dd>
        </div>
        <div>
          <dt>Abo-Umsatz pro Monat (bezahlte Abos)</dt>
          <dd>{formatEuro(counts.mrrCents)}</dd>
        </div>
      </dl>
      {user.role === 'owner' && (
        <p>
          <a href="/admin/kunden/preise">Abo-Preise</a>
        </p>
      )}
      <form className="inline-form" method="get">
        <label className="field">
          <span>Suche (E-Mail, Name, acc_…)</span>
          <input name="q" defaultValue={sp.q ?? ''} />
        </label>
        <input type="hidden" name="f" value={filter} />
        <button className="btn" type="submit">
          Suchen
        </button>
      </form>
      <p className="tabs">
        {Object.entries(FILTERS).map(([k, label]) => (
          <a
            key={k}
            href={`/admin/kunden?f=${k}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ''}`}
            aria-current={filter === k ? 'page' : undefined}
          >
            {label}
          </a>
        ))}
      </p>
      {rows.length === 0 ? (
        <p className="muted">Keine Kunden gefunden.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Kunde</th>
                <th>Abo</th>
                <th>Status</th>
                <th className="r">Geräte</th>
                <th>Läuft bis</th>
                <th>Angelegt</th>
                <th>Zuletzt angemeldet</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a href={`/admin/kunden/${r.id}`}>{r.email}</a>
                    {r.name && <div className="muted">{r.name}</div>}
                  </td>
                  <td>
                    {r.plan ? PLAN[r.plan] : '–'}
                    {r.webshopHost && <div className="muted">Webshop</div>}
                  </td>
                  <td>{statusLabel(r)}</td>
                  <td className="r">
                    {r.plan ? `${r.devices} / ${1 + r.extraDevices}` : r.devices || '–'}
                  </td>
                  <td>{dateTime(r.source === 'complimentary' ? r.endsAt : r.periodEnd)}</td>
                  <td>{dateTime(r.createdAt)}</td>
                  <td>{dateTime(r.lastLoginAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
