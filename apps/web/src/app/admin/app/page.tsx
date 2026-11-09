import { formatEuro } from '@pokeshop/core';
import { appSales, APP_NAME, listReleases } from '@pokeshop/core/licenses';
import { db, licenseServiceConfigured } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import { dateTime } from '../labels';
import { saveAppSettingsAction } from '../app-actions';
import { ApkUpload } from './ApkUpload';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'App' };

const mb = (b: number) =>
  `${new Intl.NumberFormat('de-AT', { maximumFractionDigits: 1 }).format(b / 1_000_000)} MB`;

async function serviceHealth(): Promise<boolean | null> {
  const url = process.env.LICENSE_SERVICE_URL?.trim();
  if (!url) return null;
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
    return r.ok;
  } catch {
    return false;
  }
}

export default async function AppAdmin({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const configured = licenseServiceConfigured();
  const [sales, releases, health, [stats]] = await Promise.all([
    appSales(db(), configured),
    listReleases(db(), 10),
    serviceHealth(),
    db()<{ orders: number; licenses: number; revenue: number; downloads: number }[]>`
      SELECT count(*)::int AS orders, coalesce(sum(l.quantity), 0)::int AS licenses,
             coalesce(sum(o.total_cents - o.refunded_cents), 0)::int AS revenue,
             coalesce(sum(l.downloads), 0)::int AS downloads
        FROM orders o JOIN order_licenses l ON l.order_id = o.id
       WHERE o.status IN ('paid', 'completed')`,
  ]);
  const owner = user.role === 'owner';

  return (
    <AdminShell user={user} active="app" notice={await searchParams}>
      <h1>{APP_NAME}-App</h1>
      <dl className="stats">
        <div>
          <dt>Verkauf</dt>
          <dd style={{ fontSize: 'var(--t-md)' }}>{sales.open ? 'offen' : 'geschlossen'}</dd>
        </div>
        <div>
          <dt>Verkaufte Lizenzen</dt>
          <dd>{stats?.licenses ?? 0}</dd>
        </div>
        <div>
          <dt>Umsatz</dt>
          <dd>{formatEuro(stats?.revenue ?? 0)}</dd>
        </div>
        <div>
          <dt>Downloads</dt>
          <dd>{stats?.downloads ?? 0}</dd>
        </div>
      </dl>
      {!sales.open && (
        <p className="notice notice--warn">
          {!configured
            ? 'Der Lizenzdienst ist nicht eingerichtet (LICENSE_SERVICE_URL und LICENSE_SHOP_TOKEN in der .env-Datei). Bis dahin zeigt die App-Seite „Der Verkauf startet in Kürze“.'
            : 'Es gibt noch keine APK und keinen Play-Store-Link. Lade unten die App hoch, dann ist der Verkauf offen.'}
        </p>
      )}
      <p>
        Lizenzdienst:{' '}
        {health === null ? (
          <span className="muted">nicht eingerichtet</span>
        ) : health ? (
          <strong>erreichbar</strong>
        ) : (
          <strong style={{ color: 'var(--warn)' }}>nicht erreichbar</strong>
        )}
        {' · '}
        <a href="/app" target="_blank" rel="noreferrer">
          App-Seite im Shop
        </a>
        {' · '}
        <a href="/admin/bestellungen?view=licenses">Lizenz-Bestellungen</a>
      </p>

      <section className="panel">
        <h2>App-Datei (APK)</h2>
        {sales.release ? (
          <p>
            Aktuell: <strong>Version {sales.release.version}</strong>, {mb(sales.release.sizeBytes)}
            , hochgeladen {dateTime(sales.release.createdAt)} von {sales.release.uploadedBy}.
            {sales.playStoreUrl &&
              ' Solange der Play-Store-Link gesetzt ist, führt der Download dorthin.'}
          </p>
        ) : (
          <p className="muted">Noch keine APK hochgeladen.</p>
        )}
        <p className="muted">
          Käufer bekommen einen persönlichen Download-Link; er liefert immer die neueste Datei.
          Danach aktualisiert sich die App selbst, du musst also nicht jeden Build hochladen.
        </p>
        {owner ? <ApkUpload /> : <p className="muted">Hochladen kann nur der Inhaber.</p>}
      </section>

      <section className="panel">
        <h2>Preis und Play Store</h2>
        <form action={saveAppSettingsAction} className="form-grid" style={{ alignItems: 'start' }}>
          <label className="field">
            <span>Preis pro Lizenz (€)</span>
            <input
              name="price"
              defaultValue={(sales.priceCents / 100).toFixed(2).replace('.', ',')}
              inputMode="decimal"
              disabled={!owner}
              required
            />
          </label>
          <label className="field">
            <span>Play-Store-Link</span>
            <input
              name="play_store_url"
              type="url"
              defaultValue={sales.playStoreUrl ?? ''}
              placeholder="https://play.google.com/store/apps/details?id=…"
              disabled={!owner}
            />
            <small className="muted">
              Sobald gesetzt, zeigen App-Seite, E-Mails und Download-Links auf den Play Store statt
              auf die APK.
            </small>
          </label>
          {owner && (
            <div>
              <button className="btn btn--accent" type="submit">
                Speichern
              </button>
            </div>
          )}
        </form>
      </section>

      <h2>Hochgeladene Versionen</h2>
      {releases.length === 0 ? (
        <p className="muted">Noch keine.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Größe</th>
                <th>Hochgeladen</th>
                <th>Von</th>
                <th>SHA-256</th>
                <th>Notiz</th>
              </tr>
            </thead>
            <tbody>
              {releases.map((r, i) => (
                <tr key={r.id}>
                  <td>
                    {r.version} {i === 0 && <span className="badge badge--paid">aktuell</span>}
                  </td>
                  <td>{mb(r.sizeBytes)}</td>
                  <td>{dateTime(r.createdAt)}</td>
                  <td>{r.uploadedBy}</td>
                  <td>
                    <code title={r.sha256}>{r.sha256.slice(0, 12)}…</code>
                  </td>
                  <td>{r.notes ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
