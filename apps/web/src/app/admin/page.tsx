import { formatEuro } from '@pokeshop/core';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from './AdminShell';
import { requestCardSync } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Übersicht' };

const time = (d: Date | null) =>
  d
    ? new Intl.DateTimeFormat('de-AT', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: 'Europe/Vienna',
      }).format(new Date(d))
    : '–';

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string; denied?: string }>;
}) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const [[stats], conflicts, failedImages, api, sync] = await Promise.all([
    db()<{ active: number; draft: number; copies: number; value: number; cards: number }[]>`
      SELECT (SELECT count(*) FROM products WHERE status = 'active')::int AS active,
             (SELECT count(*) FROM products WHERE status = 'draft')::int AS draft,
             (SELECT coalesce(sum(quantity), 0) FROM stock_locations)::int AS copies,
             (SELECT coalesce(sum(s.quantity * p.price_cents), 0) FROM stock_locations s JOIN products p ON p.id = s.product_id
               WHERE p.status = 'active')::bigint AS value,
             (SELECT count(*) FROM card_master)::int AS cards`,
    db()<
      {
        sku: string;
        name_de: string;
        storage_location: string;
        quantity: number;
        reserved: number;
      }[]
    >`
      SELECT p.sku, p.name_de, s.storage_location, s.quantity, s.reserved
        FROM stock_locations s JOIN products p ON p.id = s.product_id WHERE s.reserved > s.quantity`,
    db()<{ sku: string; name_de: string; error: string | null }[]>`
      SELECT p.sku, p.name_de, i.error FROM product_images i JOIN products p ON p.id = i.product_id
       WHERE i.status = 'failed' ORDER BY i.id DESC LIMIT 10`,
    db()<
      {
        method: string;
        path: string;
        status_code: number;
        error_code: string | null;
        created_at: Date;
        key_id: string | null;
      }[]
    >`
      SELECT method, path, status_code, error_code, created_at, key_id FROM api_request_log ORDER BY id DESC LIMIT 15`,
    db()<
      { status: string; finished_at: Date | null; created_at: Date; last_error: string | null }[]
    >`
      SELECT status, finished_at, created_at, last_error FROM jobs WHERE kind = 'tcgdex.sync' ORDER BY id DESC LIMIT 1`,
  ]);
  return (
    <AdminShell
      user={user}
      active="home"
      notice={{
        ok: sp.ok,
        err: sp.err ?? (sp.denied ? 'Dafür braucht es die Rolle Inhaber.' : undefined),
      }}
    >
      <h1>Übersicht</h1>
      <dl className="stats">
        <div>
          <dt>Aktive Produkte</dt>
          <dd>{stats?.active ?? 0}</dd>
        </div>
        <div>
          <dt>Entwürfe</dt>
          <dd>{stats?.draft ?? 0}</dd>
        </div>
        <div>
          <dt>Karten auf Lager</dt>
          <dd>{stats?.copies ?? 0}</dd>
        </div>
        <div>
          <dt>Lagerwert (Verkaufspreis)</dt>
          <dd>{formatEuro(Number(stats?.value ?? 0))}</dd>
        </div>
        <div>
          <dt>Karten in den Stammdaten</dt>
          <dd>{(stats?.cards ?? 0).toLocaleString('de-AT')}</dd>
        </div>
      </dl>

      {conflicts.length > 0 && (
        <>
          <h2>Bestandskonflikte</h2>
          <p className="notice notice--err">
            In diesen Boxen sind weniger Karten als offene Kassen reserviert haben. Eine laufende
            Zahlung kann nicht geliefert werden und wird erstattet.
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Karte</th>
                  <th>Box</th>
                  <th className="r">Bestand</th>
                  <th className="r">Reserviert</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.map((c) => (
                  <tr key={c.sku + c.storage_location}>
                    <td>
                      <a href={`/admin/produkte/${encodeURIComponent(c.sku)}`}>{c.name_de}</a>
                    </td>
                    <td>{c.storage_location}</td>
                    <td className="r">{c.quantity}</td>
                    <td className="r">{c.reserved}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Kartendaten (TCGdex)</h2>
      <p>
        Letzter Abgleich:{' '}
        {sync[0]
          ? `${time(sync[0].finished_at ?? sync[0].created_at)} (${sync[0].status === 'done' ? 'fertig' : sync[0].status === 'failed' ? `fehlgeschlagen: ${sync[0].last_error}` : 'läuft'})`
          : 'noch keiner'}
        . Er läuft jede Nacht automatisch.
      </p>
      {user.role === 'owner' && (
        <form action={requestCardSync} style={{ marginTop: 'var(--s-3)' }}>
          <button className="btn btn--quiet" type="submit">
            Jetzt abgleichen
          </button>
        </form>
      )}

      {failedImages.length > 0 && (
        <>
          <h2>Bilder mit Fehler</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Karte</th>
                  <th>Fehler</th>
                </tr>
              </thead>
              <tbody>
                {failedImages.map((f, i) => (
                  <tr key={i}>
                    <td>
                      <a href={`/admin/produkte/${encodeURIComponent(f.sku)}`}>{f.name_de}</a>
                    </td>
                    <td>{f.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Letzte Anfragen der Scanner-App</h2>
      {api.length === 0 ? (
        <p className="muted">Noch keine.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Schlüssel</th>
                <th>Anfrage</th>
                <th className="r">Status</th>
              </tr>
            </thead>
            <tbody>
              {api.map((r, i) => (
                <tr key={i}>
                  <td>{time(r.created_at)}</td>
                  <td>{r.key_id ?? '–'}</td>
                  <td>
                    {r.method} {r.path}
                  </td>
                  <td className="r">
                    {r.status_code}
                    {r.error_code ? ` ${r.error_code}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
