import { formatEuro } from '@pokeshop/core';
import { listOrders, orderCounts, ORDER_VIEWS, type OrderView } from '@pokeshop/core/fulfilment';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import { packAction } from '../order-actions';
import { dateTime, SHIPPING_LABELS, STATUS_LABELS } from '../labels';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Bestellungen' };

const PAGE = 50;

export default async function Orders({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string; page?: string; ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const view = (sp.view && sp.view in ORDER_VIEWS ? sp.view : 'open') as OrderView;
  const page = Math.max(1, Number(sp.page) || 1);
  const [{ rows, total }, counts] = await Promise.all([
    listOrders(db(), { view, q: sp.q, page, pageSize: PAGE }),
    orderCounts(db()),
  ]);
  const count = (v: OrderView) => {
    if (v === 'all') return Object.values(counts).reduce((a, b) => a + b, 0);
    const kind = ORDER_VIEWS[v].kind as string | null;
    return ORDER_VIEWS[v].statuses.reduce(
      (a, s) =>
        a +
        (kind === 'license' ? 0 : (counts[s] ?? 0)) +
        (kind === 'cards' ? 0 : (counts[`license:${s}`] ?? 0)),
      0,
    );
  };
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const link = (o: Record<string, string>) =>
    `?${new URLSearchParams({ view, ...(sp.q ? { q: sp.q } : {}), ...o })}`;
  const canPack = view === 'open' && rows.length > 0;

  return (
    <AdminShell user={user} active="orders" notice={sp}>
      <h1>Bestellungen</h1>
      <nav className="tabs" aria-label="Ansicht">
        {(Object.keys(ORDER_VIEWS) as OrderView[]).map((v) => (
          <a key={v} href={`?view=${v}`} aria-current={v === view ? 'page' : undefined}>
            {ORDER_VIEWS[v].label} <span className="tabs__n">{count(v)}</span>
          </a>
        ))}
      </nav>
      <form className="toolbar" method="get">
        <input type="hidden" name="view" value={view} />
        <label className="field">
          <span>Suche</span>
          <input
            name="q"
            defaultValue={sp.q}
            placeholder="Bestellnummer, Name oder E-Mail"
            style={{ minWidth: '18rem' }}
          />
        </label>
        <button className="btn" type="submit">
          Suchen
        </button>
      </form>

      <form action={packAction}>
        {canPack && (
          <p className="toolbar">
            <button className="btn btn--accent" type="submit">
              Packliste für die markierten drucken
            </button>
            <span className="muted">Die markierten Bestellungen wechseln auf „Wird gepackt“.</span>
          </p>
        )}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {canPack && (
                  <th>
                    <span className="visually-hidden">Auswahl</span>
                  </th>
                )}
                <th>Bestellung</th>
                <th>Status</th>
                <th>Kunde</th>
                <th>Versand</th>
                <th className="r">{view === 'licenses' ? 'Lizenzen' : 'Stück'}</th>
                <th className="r">Betrag</th>
                <th>{view === 'open' || view === 'packing' ? 'Bezahlt' : 'Angelegt'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {canPack && (
                    <td>
                      <input
                        type="checkbox"
                        name="order"
                        value={r.id}
                        defaultChecked
                        aria-label={`${r.number} auswählen`}
                      />
                    </td>
                  )}
                  <td>
                    <a href={`/admin/bestellungen/${r.id}`}>
                      <strong>{r.number}</strong>
                    </a>
                  </td>
                  <td>
                    <span className={`badge badge--${r.status}`}>
                      {STATUS_LABELS[r.status] ?? r.status}
                    </span>
                  </td>
                  <td>
                    {r.customer_name ?? '–'}
                    <br />
                    <span className="muted">
                      {r.email} · {r.country}
                    </span>
                  </td>
                  <td>
                    {r.kind === 'license' ? (
                      'App-Lizenz'
                    ) : r.shipping_method === 'insured' ? (
                      <strong>Versichert</strong>
                    ) : (
                      SHIPPING_LABELS[r.shipping_method]
                    )}
                  </td>
                  <td className="r">{r.copies}</td>
                  <td className="r">
                    {formatEuro(r.total_cents)}
                    {r.refunded_cents > 0 && (
                      <>
                        <br />
                        <span className="muted">−{formatEuro(r.refunded_cents)}</span>
                      </>
                    )}
                  </td>
                  <td>
                    {dateTime(view === 'open' || view === 'packing' ? r.paid_at : r.created_at)}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    Keine Bestellungen in dieser Ansicht.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </form>
      {pages > 1 && (
        <p className="toolbar" style={{ marginTop: 'var(--s-4)' }}>
          {page > 1 && <a href={link({ page: String(page - 1) })}>Vorherige Seite</a>}
          <span>
            Seite {page} von {pages}
          </span>
          {page < pages && <a href={link({ page: String(page + 1) })}>Nächste Seite</a>}
        </p>
      )}
      {view === 'packing' && rows.length > 0 && (
        <p style={{ marginTop: 'var(--s-4)' }}>
          <a className="btn" href={`/admin/packliste?ids=${rows.map((r) => r.id).join(',')}`}>
            Packliste erneut drucken
          </a>
        </p>
      )}
    </AdminShell>
  );
}
