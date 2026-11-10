import { formatEuro } from '@pokeshop/core/money';
import { listVouchers, voucherTotals } from '@pokeshop/core/vouchers';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import { VOUCHER_ORIGIN, VOUCHER_STATUS, dateTime } from '../labels';
import { createPromoVouchersAction } from '../voucher-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Gutscheine' };

type SP = {
  ok?: string;
  err?: string;
  origin?: string;
  q?: string;
  page?: string;
  created?: string;
};

export default async function Vouchers({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const origin = sp.origin === 'sold' || sp.origin === 'promo' ? sp.origin : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const [list, totals] = await Promise.all([
    listVouchers(db(), { origin, q: sp.q, limit: 50, offset: (page - 1) * 50 }),
    voucherTotals(db()),
  ]);
  const created = new Set((sp.created ?? '').split(',').map(Number));
  const today = new Date().toISOString().slice(0, 10);
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const owner = user.role === 'owner';
  return (
    <AdminShell user={user} active="vouchers" notice={sp}>
      <h1>Gutscheine</h1>
      <p style={{ maxWidth: '70ch', marginBottom: 'var(--s-4)' }}>
        Gutscheine gelten für Karten. <strong>Verkaufte</strong> hat ein Kunde bezahlt: Sie sind ein
        Zahlungsmittel, der offene Restwert ist Geld, das der Shop schuldet.{' '}
        <strong>Geschenkte</strong> hast du ohne Einnahme ausgegeben: Beim Einlösen sind sie ein
        Rabatt.
      </p>

      <dl className="stats">
        <div>
          <dt>Offen auf verkauften Gutscheinen</dt>
          <dd>{formatEuro(totals.sold_open)}</dd>
          <small className="muted">
            {totals.sold_count} verkauft für {formatEuro(totals.sold_value)} · Geld, das der Shop
            schuldet
          </small>
        </div>
        <div>
          <dt>Einlösbar auf geschenkten</dt>
          <dd>{formatEuro(totals.promo_open)}</dd>
          <small className="muted">
            {totals.promo_count} ausgegeben über {formatEuro(totals.promo_value)} · ohne Einnahme
          </small>
        </div>
      </dl>

      <section className="panel">
        <h2>Für die Buchhaltung</h2>
        <form action="/admin/gutscheine/buchhaltung" method="get" className="inline-form">
          <label className="field">
            <span>Von</span>
            <input type="date" name="from" defaultValue={yearStart} required />
          </label>
          <label className="field">
            <span>Bis</span>
            <input type="date" name="to" defaultValue={today} required />
          </label>
          <button className="btn" type="submit">
            Bewegungen als CSV
          </button>
        </form>
        <p className="muted small">
          Jede Bewegung mit Herkunft: Verkauf (Geld kam herein, noch kein Umsatz), Einlösung
          (verkauft: Zahlung einer Rechnung; geschenkt: Rabatt), Rückbuchung, Stornierung.
        </p>
      </section>

      {owner && (
        <section className="panel">
          <h2>Gutschein verschenken</h2>
          <form
            action={createPromoVouchersAction}
            className="form-grid"
            style={{ alignItems: 'start' }}
          >
            <label className="field">
              <span>Wert (€)</span>
              <input name="value" inputMode="decimal" required placeholder="z. B. 20" />
            </label>
            <label className="field">
              <span>Anzahl</span>
              <input name="count" type="number" min={1} max={200} defaultValue={1} />
              <small className="muted">Mehrere: z. B. für eine Veranstaltung.</small>
            </label>
            <label className="field">
              <span>Gültig bis (optional)</span>
              <input name="expires" type="date" />
              <small className="muted">Leer = ohne Ablauf.</small>
            </label>
            <label className="field">
              <span>Für wen / wofür (intern)</span>
              <input name="note" maxLength={300} placeholder="z. B. Brock, Geburtstag" />
            </label>
            <label className="field">
              <span>Name auf dem Gutschein (optional)</span>
              <input name="recipient" maxLength={80} />
            </label>
            <label className="field">
              <span>Nachricht auf dem Gutschein (optional)</span>
              <input name="message" maxLength={300} />
            </label>
            <div>
              <button className="btn btn--accent" type="submit">
                Gutschein anlegen
              </button>
            </div>
          </form>
        </section>
      )}

      <div className="toolbar">
        <nav className="tabs" aria-label="Herkunft">
          <a href="/admin/gutscheine" aria-current={!origin ? 'page' : undefined}>
            Alle
          </a>
          <a
            href="/admin/gutscheine?origin=sold"
            aria-current={origin === 'sold' ? 'page' : undefined}
          >
            Verkauft
          </a>
          <a
            href="/admin/gutscheine?origin=promo"
            aria-current={origin === 'promo' ? 'page' : undefined}
          >
            Geschenkt
          </a>
        </nav>
        <form method="get" className="inline-form">
          {origin && <input type="hidden" name="origin" value={origin} />}
          <label className="field">
            <span className="visually-hidden">Suche</span>
            <input
              name="q"
              defaultValue={sp.q ?? ''}
              placeholder="Code, Name, Bestellung …"
              style={{ minWidth: '16rem' }}
            />
          </label>
          <button className="btn" type="submit">
            Suchen
          </button>
        </form>
      </div>

      {list.rows.length === 0 ? (
        <p className="muted">Keine Gutscheine.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Herkunft</th>
                <th>Wert</th>
                <th>Restwert</th>
                <th>Eingelöst</th>
                <th>Status</th>
                <th>Angelegt</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((v) => (
                <tr
                  key={v.id}
                  style={created.has(v.id) ? { background: 'var(--soft, #f6f1ea)' } : undefined}
                >
                  <td>
                    <a href={`/admin/gutscheine/${v.id}`}>
                      <code>{v.code}</code>
                    </a>
                  </td>
                  <td>
                    {VOUCHER_ORIGIN[v.origin]}
                    <br />
                    <small className="muted">
                      {v.origin === 'sold'
                        ? `Bestellung ${v.order_number ?? '–'}`
                        : [v.note, v.recipient_name].filter(Boolean).join(' · ') || v.created_by}
                    </small>
                  </td>
                  <td>{formatEuro(v.value_cents)}</td>
                  <td>{formatEuro(v.balance_cents)}</td>
                  <td>
                    {formatEuro(v.redeemed_cents)}
                    {v.held_cents > 0 && (
                      <>
                        <br />
                        <small className="muted">
                          + {formatEuro(v.held_cents)} reserviert (Zahlung offen)
                        </small>
                      </>
                    )}
                  </td>
                  <td>
                    {VOUCHER_STATUS[v.status]}
                    {v.expires_at && (
                      <>
                        <br />
                        <small className="muted">bis {dateTime(v.expires_at)}</small>
                      </>
                    )}
                  </td>
                  <td>{dateTime(v.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.total > page * 50 && (
        <p>
          <a
            href={`/admin/gutscheine?${new URLSearchParams({ ...(origin ? { origin } : {}), ...(sp.q ? { q: sp.q } : {}), page: String(page + 1) })}`}
          >
            Weitere
          </a>
        </p>
      )}
    </AdminShell>
  );
}
