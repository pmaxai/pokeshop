import { notFound } from 'next/navigation';
import { formatEuro } from '@pokeshop/core';
import { FINISHES } from '@pokeshop/core/catalog';
import { packCard, toCents, unitValue } from '@pokeshop/core/pack-cards';
import {
  offerableProducts,
  OFFER_DAYS,
  seekersOfCard,
  type Offer,
  type OfferableProduct,
  type Seeker,
} from '@pokeshop/core/wanted';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../../AdminShell';
import { dateTime } from '../../labels';
import { createOfferAction, withdrawOfferAction } from '../../wanted-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Gesuchte Karte' };

const finish = (f: string | null) =>
  f ? (FINISHES[f as keyof typeof FINISHES]?.de ?? f) : 'jede Variante';

const OFFER_STATUS: Record<Offer['status'], string> = {
  open: 'offen',
  accepted: 'gekauft',
  declined: 'abgelehnt',
  withdrawn: 'zurückgezogen',
  expired: 'abgelaufen',
};

/** Does the product fit what this customer asked for? (shown, not enforced) */
function fits(s: Seeker, p: OfferableProduct) {
  const order = ['M', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];
  return (
    (!s.language || s.language === p.language) &&
    (!s.finish || s.finish === p.finish) &&
    (!s.minCondition || order.indexOf(p.condition) <= order.indexOf(s.minCondition))
  );
}

const productLabel = (p: OfferableProduct) =>
  `${p.sku} · ${p.language} · ${finish(p.finish)} · ${p.grading ?? p.condition} · ${
    p.status === 'draft'
      ? 'Entwurf'
      : p.priceCents !== null
        ? formatEuro(p.priceCents)
        : 'ohne Preis'
  } · ${p.available} frei`;

export default async function WantedCard({
  params,
  searchParams,
}: {
  params: Promise<{ card: string }>;
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const cardId = decodeURIComponent((await params).card);
  const sp = await searchParams;
  const [card, seekers, products] = await Promise.all([
    packCard(db(), cardId, ['de', 'en']),
    seekersOfCard(db(), cardId),
    offerableProducts(db(), cardId),
  ]);
  if (!card && seekers.length === 0) notFound();
  const value = card ? toCents(unitValue(card, { condition: 'NM' })) : null;
  return (
    <AdminShell user={user} active="wanted" notice={sp}>
      <p>
        <a href="/admin/gesucht">← Gesuchte Karten</a>
      </p>
      <div className="wanted-head">
        {card?.image && <img src={card.image.small} alt="" width={120} height={167} />}
        <div>
          <h1>{card?.name ?? cardId}</h1>
          <p className="muted">
            {card?.setName} · {card?.number} · {cardId}
            {card?.names.en && card.names.en !== card.name ? ` · ${card.names.en}` : ''}
          </p>
          <p>
            Marktwert NM laut Datenpaket: {value === null ? '–' : formatEuro(value)}
            {card?.pricesUpdated ? ` (Stand ${card.pricesUpdated.slice(0, 10)})` : ''}
          </p>
        </div>
      </div>

      <section className="panel">
        <h2>Produkte dieser Karte mit freiem Exemplar</h2>
        {products.length === 0 ? (
          <p className="muted">
            Keines. Lege die Karte mit der Scanner-App als Produkt an. Als <strong>Entwurf</strong>{' '}
            sieht sie nur der Kunde, dem du sie anbietest; als <strong>aktiv</strong> kann sie jeder
            kaufen, und die Suchenden bekommen automatisch eine E-Mail.
          </p>
        ) : (
          <ul>
            {products.map((p) => (
              <li key={p.id}>
                <a href={`/admin/produkte/${encodeURIComponent(p.sku)}`}>{productLabel(p)}</a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <h2>
        {seekers.length === 1
          ? '1 Kunde sucht die Karte'
          : `${seekers.length} Kunden suchen die Karte`}
      </h2>
      {seekers.length === 0 && <p className="muted">Niemand hat die Karte gerade auf der Liste.</p>}
      {seekers.map((s) => {
        const fitting = products.filter((p) => fits(s, p));
        const first = fitting[0] ?? products[0];
        const suggested =
          s.maxPriceCents ?? (first?.priceCents ? first.priceCents : value) ?? undefined;
        return (
          <section key={s.wantedId} className="panel" id={`w-${s.wantedId}`}>
            <h3>
              <a href={`/admin/kunden/${s.accountId}`}>{s.email}</a>
              {s.name && <span className="muted"> · {s.name}</span>}
            </h3>
            <dl className="plain plain--kv">
              <dt>Sprache</dt>
              <dd>{s.language ?? 'egal'}</dd>
              <dt>Variante</dt>
              <dd>{finish(s.finish)}</dd>
              <dt>Zustand</dt>
              <dd>{s.minCondition ? `${s.minCondition} oder besser` : 'egal'}</dd>
              <dt>Höchstens</dt>
              <dd>{s.maxPriceCents === null ? 'kein Limit' : formatEuro(s.maxPriceCents)}</dd>
              {s.note && (
                <>
                  <dt>Notiz</dt>
                  <dd>{s.note}</dd>
                </>
              )}
              <dt>Auf der Liste seit</dt>
              <dd>{dateTime(s.createdAt)}</dd>
            </dl>
            {s.offers.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Angebot</th>
                      <th className="r">Preis</th>
                      <th>Gültig bis</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {s.offers.map((o) => (
                      <tr key={o.id}>
                        <td>
                          {o.product.sku} · {o.product.language} · {finish(o.product.finish)} ·{' '}
                          {o.product.grading ?? o.product.condition}
                          {o.product.draft ? ' · Entwurf' : ''}
                        </td>
                        <td className="r">{formatEuro(o.priceCents)}</td>
                        <td>{dateTime(o.expiresAt)}</td>
                        <td>
                          {OFFER_STATUS[o.status]}
                          {o.orderId ? (
                            <>
                              {' '}
                              (<a href={`/admin/bestellungen/${o.orderId}`}>Bestellung</a>)
                            </>
                          ) : null}
                        </td>
                        <td>
                          {o.status === 'open' && (
                            <form action={withdrawOfferAction}>
                              <input type="hidden" name="id" value={o.id} />
                              <input type="hidden" name="card_id" value={cardId} />
                              <button type="submit" className="btn btn--small btn--quiet">
                                Zurückziehen
                              </button>
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {products.length > 0 ? (
              <form action={createOfferAction} className="form-grid">
                <input type="hidden" name="wanted_id" value={s.wantedId} />
                <input type="hidden" name="card_id" value={cardId} />
                <label className="field">
                  <span>Produkt</span>
                  <select name="product_id" defaultValue={first?.id}>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {fits(s, p) ? '' : '(passt nicht zu den Wünschen) '}
                        {productLabel(p)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Preis für den Kunden (€)</span>
                  <input
                    name="price"
                    inputMode="decimal"
                    required
                    defaultValue={suggested ? (suggested / 100).toFixed(2).replace('.', ',') : ''}
                  />
                </label>
                <label className="field">
                  <span>Gültig (Tage)</span>
                  <input
                    name="days"
                    type="number"
                    min={1}
                    max={60}
                    defaultValue={OFFER_DAYS}
                    required
                  />
                </label>
                <label className="field">
                  <span>Nachricht an den Kunden (optional)</span>
                  <textarea name="message" rows={2} maxLength={1000} />
                </label>
                <button type="submit" className="btn">
                  Angebot senden
                </button>
              </form>
            ) : null}
          </section>
        );
      })}
    </AdminShell>
  );
}
