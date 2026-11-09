import { notFound } from 'next/navigation';
import { formatEuro, formatRate } from '@pokeshop/core';
import { cardNameText, rowNames } from '@pokeshop/core/catalog';
import { orderAdmin } from '@pokeshop/core/fulfilment';
import { licenseClientFromEnv, type License } from '@pokeshop/core/license-client';
import { APP_NAME } from '@pokeshop/core/licenses';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../../AdminShell';
import {
  noteAction,
  packAction,
  refundAction,
  renderDocumentAction,
  shipAction,
} from '../../order-actions';
import { refundLicenseAction, resendLicenseMailAction } from '../../app-actions';
import { dateTime, EVENT_LABELS, MAIL_LABELS, SHIPPING_LABELS, STATUS_LABELS } from '../../labels';

export const dynamic = 'force-dynamic';

type Address = Record<string, string | undefined>;

const FINISH: Record<string, string> = {
  normal: 'normal',
  holo: 'Holo',
  reverse_holo: 'Reverse Holo',
};
const countryName = (code: string | undefined) =>
  code ? (new Intl.DisplayNames(['de-AT'], { type: 'region' }).of(code) ?? code) : '';

function AddressBlock({ a }: { a: Address | null }) {
  if (!a) return <span className="muted">–</span>;
  return (
    <address>
      {[
        a.company,
        a.name,
        a.street,
        [a.postcode, a.city].filter(Boolean).join(' '),
        countryName(a.country),
      ]
        .filter(Boolean)
        .map((l, i) => (
          <span key={i}>
            {l}
            <br />
          </span>
        ))}
    </address>
  );
}

export default async function OrderDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id)) notFound();
  const data = await orderAdmin(db(), id);
  if (!data) notFound();
  const {
    order: o,
    items,
    allocations,
    events,
    documents,
    refunds,
    mails,
    withdrawals,
    license,
  } = data;
  const sp = await searchParams;
  const isLicense = o.kind === 'license';
  const canShip = !isLicense && ['paid', 'packing'].includes(o.status);
  const canRefund =
    !isLicense &&
    ['paid', 'packing', 'shipped', 'completed'].includes(o.status) &&
    user.role === 'owner';
  // Live state of the keys (active device, revoked) from the licence service.
  let keys: (License | null)[] = [];
  const client = isLicense && license?.license_ids.length ? licenseClientFromEnv() : null;
  if (client && license) {
    keys = await Promise.all(license.license_ids.map((id) => client.get(id).catch(() => null)));
  }
  const boxesOf = (itemId: number) =>
    allocations
      .filter((a) => a.order_item_id === itemId)
      .map(
        (a) =>
          `${a.storage_location}${a.quantity > 1 ? ` (${a.quantity}×)` : ''}${a.status === 'reserved' ? ' reserviert' : ''}`,
      )
      .join(', ');
  const shippingLeft =
    o.shipping_cents -
    refunds.filter((r) => r.status === 'succeeded').reduce((a, r) => a + r.shipping_cents, 0);

  return (
    <AdminShell user={user} active="orders" notice={sp}>
      <p>
        <a href="/admin/bestellungen">Bestellungen</a>
      </p>
      <h1>
        {o.number}{' '}
        <span className={`badge badge--${o.status}`}>{STATUS_LABELS[o.status] ?? o.status}</span>
      </h1>
      <dl className="stats">
        <div>
          <dt>Betrag</dt>
          <dd>{formatEuro(o.total_cents)}</dd>
        </div>
        <div>
          <dt>Versand</dt>
          <dd style={{ fontSize: 'var(--t-md)' }}>{SHIPPING_LABELS[o.shipping_method]}</dd>
        </div>
        <div>
          <dt>Bezahlt</dt>
          <dd style={{ fontSize: 'var(--t-md)' }}>{dateTime(o.paid_at)}</dd>
        </div>
        {o.refunded_cents > 0 && (
          <div>
            <dt>Erstattet</dt>
            <dd>{formatEuro(o.refunded_cents)}</dd>
          </div>
        )}
      </dl>

      {canShip && (
        <section className="panel panel--action">
          <h2>Packen und versenden</h2>
          <div className="actions">
            {o.status === 'paid' ? (
              <form action={packAction}>
                <input type="hidden" name="order" value={o.id} />
                <button className="btn" type="submit">
                  Packliste drucken
                </button>
              </form>
            ) : (
              <a className="btn" href={`/admin/packliste?ids=${o.id}`}>
                Packliste erneut drucken
              </a>
            )}
            <form action={shipAction} className="inline-form">
              <input type="hidden" name="id" value={o.id} />
              <label className="field">
                <span>
                  Sendungsnummer
                  {o.shipping_method === 'standard' ? ' (falls vorhanden)' : ' (Pflicht)'}
                </span>
                <input
                  name="tracking"
                  required={o.shipping_method !== 'standard'}
                  placeholder="z. B. RR123456789AT"
                  autoComplete="off"
                />
              </label>
              <button className="btn btn--accent" type="submit">
                Als versendet markieren
              </button>
            </form>
          </div>
          <p className="muted">
            Beim Versenden wird die Rechnung erstellt und mit der Versandbestätigung an den Kunden
            geschickt.
          </p>
        </section>
      )}

      <div className="two-col">
        {isLicense && license ? (
          <section>
            <h2>{APP_NAME}-Lizenzen</h2>
            <p>
              {license.quantity} × {formatEuro(license.unit_price_cents)} · Sofortlieferung verlangt
              am {dateTime(license.immediate_delivery_consent_at)}
            </p>
            <p>
              {license.issued_at ? (
                <>Verschickt {dateTime(license.issued_at)}</>
              ) : (
                <span className="muted">
                  Noch nicht verschickt (kommt direkt nach der Zahlung).
                </span>
              )}
              {license.revoked_at && <> · gesperrt {dateTime(license.revoked_at)}</>}
              {' · '}
              {license.downloads} Download{license.downloads === 1 ? '' : 's'}
              {license.last_download_at && <>, zuletzt {dateTime(license.last_download_at)}</>}
            </p>
            {license.license_ids.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Lizenz</th>
                      <th>Schlüssel</th>
                      <th>Aktiv auf</th>
                      <th>Geräte bisher</th>
                    </tr>
                  </thead>
                  <tbody>
                    {license.license_ids.map((id, i) => {
                      const k = keys[i];
                      return (
                        <tr key={id}>
                          <td>
                            <code>{id}</code>
                          </td>
                          <td>
                            {k ? <code>…{k.key.slice(-5)}</code> : <span className="muted">–</span>}
                          </td>
                          <td>
                            {k?.revoked_at ? (
                              <strong>gesperrt</strong>
                            ) : k?.active_device ? (
                              `${k.active_device.name ?? 'Gerät'} seit ${dateTime(k.active_device.since)}`
                            ) : (
                              <span className="muted">noch nicht aktiviert</span>
                            )}
                          </td>
                          <td>{k?.activations ?? '–'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {license.issued_at && !license.revoked_at && (
              <form action={resendLicenseMailAction} className="actions">
                <input type="hidden" name="id" value={o.id} />
                <button className="btn" type="submit">
                  Lizenz-E-Mail erneut senden
                </button>
              </form>
            )}
          </section>
        ) : (
          <section>
            <h2>Karten</h2>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Box</th>
                    <th>Karte</th>
                    <th className="r">Menge</th>
                    <th className="r">Preis</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <strong>{boxesOf(i.id) || '–'}</strong>
                      </td>
                      <td>
                        <a href={`/admin/produkte/${encodeURIComponent(i.sku)}`}>
                          {cardNameText(rowNames(i, 'de'))}
                        </a>{' '}
                        {i.card_number}
                        <br />
                        <span className="muted">
                          {i.set_name_de} · {i.card_language} · {i.condition} ·{' '}
                          {FINISH[i.finish] ?? i.finish}
                          {i.high_value ? ' · wertvoll' : ''}
                        </span>
                        {i.refunded_quantity > 0 && (
                          <>
                            <br />
                            <span className="warn">
                              {i.refunded_quantity} erstattet
                              {i.restocked_quantity
                                ? `, ${i.restocked_quantity} zurück ins Lager`
                                : ''}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="r">{i.quantity}</td>
                      <td className="r">{formatEuro(i.unit_price_cents * i.quantity)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3}>{SHIPPING_LABELS[o.shipping_method]}</td>
                    <td className="r">{formatEuro(o.shipping_cents)}</td>
                  </tr>
                  <tr>
                    <td colSpan={3}>
                      <strong>Gesamt</strong>{' '}
                      <span className="muted">
                        {o.vat_regime === 'small_business'
                          ? 'ohne USt. (Kleinunternehmer)'
                          : `inkl. ${formatRate(o.vat_rate_bp)} USt. (${formatEuro(o.vat_cents)})`}
                      </span>
                    </td>
                    <td className="r">
                      <strong>{formatEuro(o.total_cents)}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        )}
        <section>
          <h2>Kunde</h2>
          <p>
            <a href={`mailto:${o.email}`}>{o.email}</a>
            {o.phone && (
              <>
                <br />
                {o.phone}
              </>
            )}
          </p>
          {!isLicense && (
            <>
              <h3>Lieferadresse</h3>
              <AddressBlock a={o.shipping_address as Address} />
            </>
          )}
          {JSON.stringify(o.billing_address) !== JSON.stringify(o.shipping_address) && (
            <>
              <h3>Rechnungsadresse</h3>
              <AddressBlock a={o.billing_address as Address} />
            </>
          )}
          <h3>Zahlung</h3>
          <p>
            {o.payment_method_type ?? '–'}
            {o.stripe_payment_intent_id && (
              <>
                {' · '}
                <a
                  href={`https://dashboard.stripe.com/payments/${o.stripe_payment_intent_id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  in Stripe öffnen
                </a>
              </>
            )}
          </p>
          {o.tracking_number && (
            <>
              <h3>Sendung</h3>
              <p>
                {o.tracking_number} · versendet {dateTime(o.shipped_at)}
              </p>
            </>
          )}
        </section>
      </div>

      {canRefund && (
        <section className="panel">
          <h2>Erstatten</h2>
          <form action={refundAction} className="stack-admin">
            <input type="hidden" name="id" value={o.id} />
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Karte</th>
                    <th>Menge erstatten</th>
                    <th>Zurück in die Box</th>
                  </tr>
                </thead>
                <tbody>
                  {items
                    .filter((i) => i.quantity > i.refunded_quantity)
                    .map((i) => (
                      <tr key={i.id}>
                        <td>
                          {cardNameText(rowNames(i, 'de'))} {i.card_number}{' '}
                          <span className="muted">({formatEuro(i.unit_price_cents)} je Stück)</span>
                        </td>
                        <td>
                          <select
                            name={`qty_${i.id}`}
                            defaultValue="0"
                            aria-label={`Menge ${i.name_de}`}
                          >
                            {Array.from(
                              { length: i.quantity - i.refunded_quantity + 1 },
                              (_, n) => (
                                <option key={n} value={n}>
                                  {n}
                                </option>
                              ),
                            )}
                          </select>
                        </td>
                        <td>
                          <label className="check">
                            <input type="checkbox" name={`restock_${i.id}`} defaultChecked /> wieder
                            verkaufen
                          </label>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {shippingLeft > 0 && (
              <label className="check">
                <input type="checkbox" name="shipping" /> Versandkosten erstatten (
                {formatEuro(shippingLeft)})
              </label>
            )}
            <label className="field">
              <span>Grund (intern, z. B. Widerruf, beschädigt)</span>
              <input name="reason" maxLength={500} />
            </label>
            <label className="check">
              <input type="checkbox" name="confirm" required /> Ich will diesen Betrag über Stripe
              zurückzahlen.
            </label>
            <p>
              <button className="btn btn--accent" type="submit">
                Erstatten
              </button>
            </p>
            <p className="muted">
              Der Kunde bekommt eine E-Mail; ist die Bestellung schon verrechnet, mit
              Rechnungskorrektur. „Wieder verkaufen“ legt die Karte zurück in die Box, aus der sie
              kam.
            </p>
          </form>
        </section>
      )}

      {isLicense && user.role === 'owner' && ['paid', 'completed'].includes(o.status) && (
        <section className="panel">
          <h2>Erstatten</h2>
          <form action={refundLicenseAction} className="stack-admin">
            <input type="hidden" name="id" value={o.id} />
            <p>
              Erstattet den vollen Betrag ({formatEuro(o.total_cents - o.refunded_cents)}) über
              Stripe und sperrt die Lizenzschlüssel: Die App hört beim nächsten Online-Check auf.
            </p>
            <label className="field">
              <span>Grund (intern)</span>
              <input name="reason" maxLength={500} />
            </label>
            <label className="check">
              <input type="checkbox" name="confirm" required /> Ich will erstatten und die Lizenz
              sperren.
            </label>
            <p>
              <button className="btn btn--accent" type="submit">
                Erstatten und sperren
              </button>
            </p>
          </form>
        </section>
      )}

      <div className="two-col">
        <section>
          <h2>Dokumente</h2>
          {documents.length === 0 ? (
            <p className="muted">
              {isLicense
                ? 'Die Rechnung entsteht, sobald die Lizenz verschickt ist.'
                : 'Die Rechnung entsteht beim Versenden.'}
            </p>
          ) : (
            <ul className="plain">
              {documents.map((d) => (
                <li key={d.id}>
                  {d.kind === 'invoice' ? 'Rechnung' : 'Rechnungskorrektur'} {d.number} ·{' '}
                  {formatEuro(d.gross_cents)} · {dateTime(d.issued_at)}{' '}
                  {d.pdf_key ? (
                    <a href={`/admin/dokumente/${d.id}`}>PDF</a>
                  ) : (
                    <form action={renderDocumentAction} style={{ display: 'inline' }}>
                      <input type="hidden" name="id" value={o.id} />
                      <input type="hidden" name="document" value={d.id} />
                      <button className="linklike" type="submit">
                        PDF erstellen
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {refunds.length > 0 && (
            <>
              <h3>Erstattungen</h3>
              <ul className="plain">
                {refunds.map((r) => (
                  <li key={r.id}>
                    {formatEuro(r.amount_cents)} ·{' '}
                    {r.status === 'succeeded'
                      ? 'erledigt'
                      : r.status === 'failed'
                        ? `fehlgeschlagen: ${r.error}`
                        : 'läuft'}{' '}
                    · {r.reason ?? ''} · {r.created_by} · {dateTime(r.created_at)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {withdrawals.length > 0 && (
            <>
              <h3>Widerrufe</h3>
              <ul className="plain">
                {withdrawals.map((w) => (
                  <li key={w.id}>
                    {dateTime(w.received_at)}: {w.items || 'ganze Bestellung'}{' '}
                    {w.handled_at ? '(erledigt)' : <a href="/admin/widerrufe">offen</a>}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h2>Interne Notiz</h2>
          <form action={noteAction} className="stack-admin">
            <input type="hidden" name="id" value={o.id} />
            <label className="field">
              <span className="visually-hidden">Notiz</span>
              <textarea name="note" defaultValue={o.internal_note ?? ''} maxLength={4000} />
            </label>
            <p>
              <button className="btn btn--quiet" type="submit">
                Notiz speichern
              </button>
            </p>
          </form>
        </section>
        <section>
          <h2>Verlauf</h2>
          <ol className="timeline">
            {events.map((e, i) => (
              <li key={i}>
                <span className="muted">{dateTime(e.created_at)}</span>{' '}
                {e.kind === 'created' && isLicense
                  ? 'Bestellung angelegt'
                  : (EVENT_LABELS[e.kind] ?? e.kind)}
                {e.actor !== 'system' && <span className="muted"> · {e.actor}</span>}
              </li>
            ))}
          </ol>
          <h2>E-Mails</h2>
          <ul className="plain">
            {mails.map((m, i) => (
              <li key={i}>
                {MAIL_LABELS[m.template] ?? m.template} an {m.to_address} ·{' '}
                {m.status === 'sent'
                  ? `gesendet ${dateTime(m.sent_at)}`
                  : m.status === 'failed'
                    ? `fehlgeschlagen: ${m.last_error}`
                    : 'wartet'}
              </li>
            ))}
            {mails.length === 0 && <li className="muted">Keine.</li>}
          </ul>
        </section>
      </div>
    </AdminShell>
  );
}
