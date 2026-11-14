import { formatEuro } from '@pokeshop/core';
import { wantedCounts, wantedDemand } from '@pokeshop/core/wanted';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import { dateTime } from '../labels';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Gesuchte Karten' };

/** What customers are looking for (their lists of missing cards), most wanted first. */
export default async function WantedCards({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const [rows, counts] = await Promise.all([
    wantedDemand(db(), { query: sp.q }),
    wantedCounts(db()),
  ]);
  return (
    <AdminShell user={user} active="wanted" notice={sp}>
      <h1>Gesuchte Karten</h1>
      <p className="muted">
        Karten auf den Listen „Fehlende Karten“ der Abo-Kunden. Ein Klick auf die Karte zeigt, wer
        sie sucht, und dort machst du ein Angebot. Kommt eine passende Karte in den Shop, bekommen
        die Kunden automatisch eine E-Mail.
      </p>
      <dl className="stats">
        <div>
          <dt>Gesuchte Karten</dt>
          <dd>{counts.cards}</dd>
        </div>
        <div>
          <dt>Einträge</dt>
          <dd>{counts.entries}</dd>
        </div>
        <div>
          <dt>Offene Angebote</dt>
          <dd>{counts.openOffers}</dd>
        </div>
      </dl>
      <form className="inline-form" method="get">
        <label className="field">
          <span>Suche (Name, Karten-ID)</span>
          <input name="q" defaultValue={sp.q ?? ''} />
        </label>
        <button className="btn" type="submit">
          Suchen
        </button>
      </form>
      {rows.length === 0 ? (
        <p className="muted">{sp.q ? 'Nichts gefunden.' : 'Noch sucht niemand eine Karte.'}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Karte</th>
                <th className="r">Kunden</th>
                <th>Sprachen</th>
                <th className="r">Höchstpreis</th>
                <th className="r">Marktwert NM</th>
                <th className="r">Im Shop</th>
                <th className="r">Entwürfe</th>
                <th className="r">Angebote</th>
                <th>Zuletzt</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.cardId}>
                  <td>
                    <a
                      href={`/admin/gesucht/${encodeURIComponent(r.cardId)}`}
                      className="wanted-row"
                    >
                      {r.card?.image ? (
                        <img
                          src={r.card.image.small}
                          alt=""
                          width={36}
                          height={50}
                          loading="lazy"
                        />
                      ) : null}
                      <span>
                        <strong>{r.card?.name ?? r.cardId}</strong>
                        <span className="muted">
                          {' '}
                          {r.card?.setName} · {r.card?.number}
                        </span>
                      </span>
                    </a>
                  </td>
                  <td className="r">{r.customers}</td>
                  <td>{r.languages.map((l) => (l === '*' ? 'egal' : l)).join(', ')}</td>
                  <td className="r">
                    {r.maxPriceCents === null ? 'offen' : formatEuro(r.maxPriceCents)}
                  </td>
                  <td className="r">{r.valueCents === null ? '–' : formatEuro(r.valueCents)}</td>
                  <td className="r">{r.inShop || '–'}</td>
                  <td className="r">{r.drafts || '–'}</td>
                  <td className="r">{r.openOffers || '–'}</td>
                  <td>{dateTime(r.newest)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
