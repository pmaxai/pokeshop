import { notFound } from 'next/navigation';
import { formatEuro } from '@pokeshop/core';
import { accountById, accountOrders } from '@pokeshop/core/accounts';
import { listDevices } from '@pokeshop/core/devices';
import {
  accountEntitlements,
  monthlyCents,
  subscriptionOf,
  subscriptionPrices,
} from '@pokeshop/core/subscriptions';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../../AdminShell';
import {
  STORE_STATE,
  dateTime,
  STATUS_LABELS,
  subscriptionStatusLabel as statusLabel,
} from '../../labels';
import {
  adminCancelAction,
  adminNoteAction,
  adminRemoveDeviceAction,
  endComplimentaryAction,
  grantComplimentaryAction,
  s3ConfigAction,
  serviceAction,
  webshopHostAction,
} from '../../customer-actions';
import {
  billingPeriodStart,
  recentUsage,
  s3Config,
  serviceStates,
  usageSince,
} from '@pokeshop/core/usage';
import { apiMasterKey } from '@/server/config';
import { activeDeviceAddOns, storeManageUrl, storePurchasesOf } from '@pokeshop/core/store';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Kunde' };

const PLAN = { collector: 'Collector', creator: 'Creator' } as const;
const REGIME: Record<string, string> = {
  domestic: 'Österreich (20 % USt.)',
  oss: 'EU-Privatkunde (USt. des Landes, OSS)',
  reverse_charge: 'EU-Unternehmen (Reverse Charge)',
};

export default async function Customer({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const { id: raw } = await params;
  const sp = await searchParams;
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) notFound();
  const account = await accountById(db(), id);
  if (!account) notFound();
  const [sub, ent, devices, orders, prices, [extra]] = await Promise.all([
    subscriptionOf(db(), id),
    accountEntitlements(db(), account),
    listDevices(db(), id),
    accountOrders(db(), id, 20),
    subscriptionPrices(db()),
    db()<
      {
        admin_note: string | null;
        stripe_customer_id: string | null;
        billing: Record<string, string> | null;
      }[]
    >`
      SELECT admin_note, stripe_customer_id, billing FROM accounts WHERE id = ${id}`,
  ]);
  const [services, s3, period, events] = await Promise.all([
    serviceStates(db(), id),
    s3Config(db(), id, apiMasterKey()).catch(() => null),
    billingPeriodStart(db(), id),
    recentUsage(db(), id, 10),
  ]);
  const usage = await usageSince(db(), id, period);
  const purchases = await storePurchasesOf(db(), id);
  const deviceSubs = await db()<
    {
      stripe_subscription_id: string;
      plan: 'collector' | 'creator';
      devices: number;
      status: string;
      current_period_end: Date | null;
      cancel_at_period_end: boolean;
      ended_at: Date | null;
      ended_reason: string | null;
      refunded_cents: number | null;
      created_at: Date;
    }[]
  >`SELECT stripe_subscription_id, plan, devices, status, current_period_end, cancel_at_period_end,
           ended_at, ended_reason, refunded_cents, created_at
      FROM device_subscriptions WHERE account_id = ${id} ORDER BY created_at DESC LIMIT 10`;
  const owner = user.role === 'owner';
  const test = (process.env.STRIPE_LICENSE_SECRET_KEY ?? '').startsWith('sk_test');
  const dash = (kind: string, sid: string) =>
    `https://dashboard.stripe.com/${test ? 'test/' : ''}${kind}/${sid}`;
  const billingInfo = extra?.billing;
  return (
    <AdminShell user={user} active="customers" notice={sp}>
      <p>
        <a href="/admin/kunden">← Kunden</a>
      </p>
      <h1>{account.email}</h1>
      <p className="muted">
        {account.name ?? 'ohne Namen'} · {account.publicId} · Sprache{' '}
        {account.locale === 'de' ? 'Deutsch' : 'Englisch'} · angelegt {dateTime(account.createdAt)}{' '}
        · zuletzt angemeldet {dateTime(account.lastLoginAt)}
        {account.signupVia !== 'portal' && (
          <>
            {' '}
            · angelegt in der App (
            {
              { google: 'Google', apple: 'Apple', email: 'E-Mail-Code', review: 'Review' }[
                account.signupVia
              ]
            }
            ){account.emailVerified ? '' : ', E-Mail-Adresse noch nicht bestätigt'}
          </>
        )}
      </p>

      <section className="panel">
        <h2>Abo</h2>
        {sub ? (
          <dl className="plain plain--kv">
            <dt>Abo</dt>
            <dd>
              {PLAN[sub.plan]} · {statusLabel({ ...sub, cancelAtPeriodEnd: sub.cancelAtPeriodEnd })}
              {ent.active ? '' : ' (App gesperrt)'}
            </dd>
            <dt>Geräte</dt>
            <dd>
              {devices.length} von {1 + sub.extraDevices} belegt ({sub.extraDevices} zusätzlich)
            </dd>
            {sub.source === 'stripe' && (
              <>
                <dt>Preis</dt>
                <dd>
                  {formatEuro(
                    monthlyCents(prices, sub.plan, sub.extraDevices, sub.taxBehavior ?? 'incl'),
                  )}{' '}
                  pro Monat {sub.taxBehavior === 'excl' ? 'netto' : 'brutto'}
                </dd>
                <dt>Bezahlt bis</dt>
                <dd>{dateTime(sub.currentPeriodEnd)}</dd>
                <dt>Stripe</dt>
                <dd>
                  <a
                    href={dash('subscriptions', sub.stripeSubscriptionId!)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Abo im Stripe-Dashboard
                  </a>
                  {extra?.stripe_customer_id && (
                    <>
                      {' · '}
                      <a
                        href={dash('customers', extra.stripe_customer_id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Kunde
                      </a>
                    </>
                  )}
                </dd>
              </>
            )}
            {(sub.source === 'google_play' || sub.source === 'app_store') && (
              <>
                <dt>Gekauft in</dt>
                <dd>
                  {sub.source === 'google_play' ? 'Google Play' : 'App Store'} · Produkt{' '}
                  <code>{sub.storeProductId}</code> · verwaltet und gekündigt im Store, nicht hier
                </dd>
                <dt>{sub.cancelAtPeriodEnd ? 'Läuft bis' : 'Verlängert sich am'}</dt>
                <dd>{dateTime(sub.currentPeriodEnd)}</dd>
              </>
            )}
            {sub.source === 'complimentary' && (
              <>
                <dt>Gratis bis</dt>
                <dd>{sub.endsAt ? dateTime(sub.endsAt) : 'ohne Ende'}</dd>
                <dt>Vergeben von</dt>
                <dd>
                  {sub.grantedBy ?? '–'}
                  {sub.note ? ` – ${sub.note}` : ''}
                </dd>
              </>
            )}
          </dl>
        ) : (
          <p className="muted">Kein Abo.</p>
        )}
        {owner && sub?.source === 'stripe' && ent.active && (
          <form action={adminCancelAction} className="inline-form">
            <input type="hidden" name="id" value={id} />
            {sub.cancelAtPeriodEnd ? (
              <>
                <input type="hidden" name="resume" value="1" />
                <button className="btn btn--quiet" type="submit">
                  Kündigung zurücknehmen
                </button>
              </>
            ) : (
              <button className="btn btn--quiet" type="submit">
                Zum Ende des bezahlten Monats kündigen
              </button>
            )}
          </form>
        )}
      </section>
      {billingInfo && (
        <>
          <h3>Rechnungsdaten (Antalyse GmbH)</h3>
          <p>
            {billingInfo.company && (
              <>
                {billingInfo.company}
                <br />
              </>
            )}
            {billingInfo.name}
            <br />
            {billingInfo.street}, {billingInfo.postcode} {billingInfo.city}, {billingInfo.country}
            {billingInfo.vat_id && (
              <>
                <br />
                UID {billingInfo.vat_id}
                {billingInfo.vies_name ? ` (VIES: ${billingInfo.vies_name})` : ''}
              </>
            )}
            <br />
            <span className="muted">{REGIME[billingInfo.regime ?? ''] ?? ''}</span>
          </p>
        </>
      )}

      {owner && !(sub?.source === 'stripe' && ent.active) && (
        <>
          <h3>Gratis-Abo vergeben</h3>
          <form action={grantComplimentaryAction} className="form-grid">
            <input type="hidden" name="id" value={id} />
            <label className="field">
              <span>Abo</span>
              <select name="plan" defaultValue={sub?.plan ?? 'collector'}>
                <option value="collector">Collector</option>
                <option value="creator">Creator</option>
              </select>
            </label>
            <label className="field">
              <span>Zusätzliche Geräte</span>
              <input
                name="extraDevices"
                type="number"
                min={0}
                max={20}
                defaultValue={sub?.extraDevices ?? 0}
              />
            </label>
            <label className="field">
              <span>Bis einschließlich (leer = ohne Ende)</span>
              <input
                name="until"
                type="date"
                defaultValue={
                  sub?.source === 'complimentary' && sub.endsAt
                    ? sub.endsAt.toISOString().slice(0, 10)
                    : ''
                }
              />
            </label>
            <label className="field">
              <span>Notiz (z. B. Anlass)</span>
              <input
                name="note"
                maxLength={500}
                defaultValue={sub?.source === 'complimentary' ? (sub.note ?? '') : ''}
              />
            </label>
            <div className="inline-form">
              <button className="btn" type="submit">
                {sub?.source === 'complimentary' ? 'Gratis-Abo ändern' : 'Gratis-Abo vergeben'}
              </button>
            </div>
          </form>
          {sub?.source === 'complimentary' && ent.active && (
            <form action={endComplimentaryAction} className="inline-form">
              <input type="hidden" name="id" value={id} />
              <button className="btn btn--quiet" type="submit">
                Gratis-Abo jetzt beenden
              </button>
            </form>
          )}
        </>
      )}

      <h2>Geräte</h2>
      {devices.length === 0 ? (
        <p className="muted">Keine Geräte verbunden.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Gerät</th>
                <th>App-Version</th>
                <th>Verbunden</th>
                <th>Zuletzt gesehen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.publicId}>
                  <td>
                    {d.name ?? 'ohne Namen'} <span className="muted">{d.publicId}</span>
                  </td>
                  <td>{d.appVersion ?? '–'}</td>
                  <td>{dateTime(d.pairedAt)}</td>
                  <td>{dateTime(d.lastSeenAt)}</td>
                  <td>
                    <form action={adminRemoveDeviceAction}>
                      <input type="hidden" name="id" value={id} />
                      <input type="hidden" name="device" value={d.publicId} />
                      <button className="btn btn--small btn--quiet" type="submit">
                        Entfernen
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {purchases.length > 0 && (
        <>
          <h2>Käufe in den App-Stores</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Produkt</th>
                  <th>Status</th>
                  <th>Läuft bis</th>
                  <th>Bestellung</th>
                  <th>Gekauft</th>
                </tr>
              </thead>
              <tbody>
                {purchases.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <a
                        href={storeManageUrl(p.store, p.productId)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {p.store === 'google_play' ? 'Google Play' : 'App Store'}
                      </a>
                      {p.test && <div className="muted">Testkauf</div>}
                    </td>
                    <td>
                      <code>{p.productId}</code>
                      {p.plan && (
                        <div className="muted">
                          {PLAN[p.plan]}
                          {p.period ? `, ${p.period === 'yearly' ? 'jährlich' : 'monatlich'}` : ''}
                        </div>
                      )}
                    </td>
                    <td>
                      {STORE_STATE[p.state] ?? p.state}
                      {p.refused && <div className="muted">abgelehnt: hatte schon ein Abo</div>}
                      {p.replacedBy && <div className="muted">ersetzt (Wechsel)</div>}
                      {!p.acknowledged && !p.refused && p.state !== 'pending' && (
                        <div className="muted">nicht bestätigt</div>
                      )}
                      {p.deviceAddOns.length > 0 && (
                        <div className="muted">
                          {`+${activeDeviceAddOns(p.deviceAddOns)} Gerät(e) als Add-on`}
                          {activeDeviceAddOns(p.deviceAddOns) < p.deviceAddOns.length &&
                            ` (${p.deviceAddOns.length - activeDeviceAddOns(p.deviceAddOns)} abgelaufen)`}
                        </div>
                      )}
                    </td>
                    <td>
                      {dateTime(p.expiresAt)}
                      <div className="muted">
                        {p.autoRenew ? 'verlängert sich' : 'verlängert sich nicht'}
                      </div>
                    </td>
                    <td>
                      <code>{p.latestOrderId ?? '–'}</code>
                    </td>
                    <td>{dateTime(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {deviceSubs.length > 0 && (
        <>
          <h2>Zusätzliche Geräte im Konto (zum Store-Abo)</h2>
          <p className="muted">
            Eigenes Stripe-Abo nur für Geräte. Endet sofort, wenn das Store-Abo nicht mehr läuft;
            der nicht genutzte Teil der letzten Zahlung wird erstattet (Gutschrift).
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Stripe</th>
                  <th className="r">Geräte</th>
                  <th>Status</th>
                  <th>Zeitraum bis</th>
                  <th>Seit</th>
                </tr>
              </thead>
              <tbody>
                {deviceSubs.map((d) => (
                  <tr key={d.stripe_subscription_id}>
                    <td>
                      {owner ? (
                        <a
                          href={dash('subscriptions', d.stripe_subscription_id)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <code>{d.stripe_subscription_id}</code>
                        </a>
                      ) : (
                        <code>{d.stripe_subscription_id}</code>
                      )}
                      <div className="muted">{PLAN[d.plan]}-Preis</div>
                    </td>
                    <td className="r">{d.devices}</td>
                    <td>
                      {d.ended_at ? 'beendet' : d.status}
                      {d.cancel_at_period_end && !d.ended_at && (
                        <div className="muted">endet zum Monatsende</div>
                      )}
                      {d.ended_reason === 'store_ended' && (
                        <div className="muted">
                          {`Store-Abo beendet, erstattet: ${formatEuro(d.refunded_cents ?? 0, 'de')}`}
                        </div>
                      )}
                    </td>
                    <td>{dateTime(d.current_period_end)}</td>
                    <td>{dateTime(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2 id="dienste">Dienste nach Nutzung (Creator)</h2>
      <p className="muted">
        S3-Speicher für Aufnahmen und die Video-Pipeline. Die Pipeline meldet die Nutzung über{' '}
        <code>POST /api/v1/usage</code> (API-Schlüssel „Video-Pipeline“); Stripe verrechnet sie mit
        der nächsten Abo-Rechnung zu den Preisen unter <a href="/admin/kunden/preise">Abo-Preise</a>
        . In der App gibt es die Dienste nur mit Creator.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Dienst</th>
              <th>Status</th>
              <th className="r">Seit {dateTime(usage.since)}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(['s3', 'pipeline'] as const).map((k) => {
              const st = services[k];
              const amount =
                k === 's3'
                  ? `${(usage.s3.mb / 1024).toLocaleString('de-AT', { maximumFractionDigits: 2 })} GB`
                  : `${(usage.pipeline.seconds / 60).toLocaleString('de-AT', { maximumFractionDigits: 1 })} min`;
              const cents = k === 's3' ? usage.s3.cents : usage.pipeline.cents;
              return (
                <tr key={k}>
                  <td>{k === 's3' ? 'S3-Speicher' : 'Video-Pipeline'}</td>
                  <td>
                    {st.enabled
                      ? `an seit ${dateTime(st.enabledAt)}${st.enabledBy ? ` (${st.enabledBy})` : ''}`
                      : st.disabledAt
                        ? `aus seit ${dateTime(st.disabledAt)}`
                        : 'aus'}
                    {k === 'pipeline' && st.enabled && !services.s3.enabled && (
                      <div className="muted">Braucht auch S3-Speicher.</div>
                    )}
                  </td>
                  <td className="r">
                    {amount}
                    {cents !== null && <div className="muted">≈ {formatEuro(cents)}</div>}
                  </td>
                  <td>
                    {owner && (
                      <form action={serviceAction}>
                        <input type="hidden" name="id" value={id} />
                        <input type="hidden" name="service" value={k} />
                        <input type="hidden" name="on" value={st.enabled ? '0' : '1'} />
                        <button type="submit" className="btn btn--small btn--quiet">
                          {st.enabled ? 'Ausschalten' : 'Einschalten'}
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {owner && services.s3.enabled && (
        <form action={s3ConfigAction} className="form-grid">
          <input type="hidden" name="id" value={id} />
          <label className="field">
            <span>Anbieter</span>
            <select name="provider" defaultValue={s3?.provider ?? 'exoscale'}>
              <option value="exoscale">Exoscale</option>
              <option value="aws">AWS</option>
              <option value="other">Andere</option>
            </select>
          </label>
          <label className="field">
            <span>Endpoint</span>
            <input
              name="endpoint"
              defaultValue={s3?.endpoint ?? 'https://sos-at-vie-1.exo.io'}
              required
            />
          </label>
          <label className="field">
            <span>Region</span>
            <input name="region" defaultValue={s3?.region ?? 'at-vie-1'} required />
          </label>
          <label className="field">
            <span>Bucket</span>
            <input name="bucket" defaultValue={s3?.bucket ?? ''} required />
          </label>
          <label className="field">
            <span>Präfix</span>
            <input name="prefix" defaultValue={s3?.prefix ?? `${account.publicId}/`} />
          </label>
          <label className="field">
            <span>Access Key ID</span>
            <input name="access_key_id" defaultValue={s3?.access_key_id ?? ''} required />
          </label>
          <label className="field">
            <span>Secret Access Key</span>
            <input
              name="secret_access_key"
              type="password"
              autoComplete="off"
              placeholder={s3 ? 'gespeichert – leer lassen zum Behalten' : ''}
              required={!s3}
            />
          </label>
          <button type="submit" className="btn">
            S3-Einstellungen speichern
          </button>
          {services.s3.configUpdatedAt && (
            <p className="muted">Zuletzt geändert {dateTime(services.s3.configUpdatedAt)}.</p>
          )}
        </form>
      )}
      {events.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="muted">Letzte Meldungen der Pipeline</caption>
            <thead>
              <tr>
                <th>Wann</th>
                <th>Dienst</th>
                <th className="r">Menge</th>
                <th>Referenz</th>
                <th>Stripe</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{dateTime(e.occurredAt)}</td>
                  <td>{e.service === 's3' ? 'S3' : 'Pipeline'}</td>
                  <td className="r">
                    {e.quantity.toLocaleString('de-AT')} {e.unit === 'mb' ? 'MB' : 's'}
                  </td>
                  <td>{e.reference ?? '–'}</td>
                  <td>
                    {
                      {
                        queued: 'wartet',
                        sent: 'gemeldet',
                        not_billed: 'nicht verrechnet (Gratis-Abo)',
                        failed: 'abgelehnt',
                      }[e.billing]
                    }
                    {e.billingError && <div className="muted">{e.billingError}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Webshop as a Service</h2>
      <p className="muted">
        Mit einem eingetragenen Webshop zeigt die App den Webshop-Modus (der API-Schlüssel wird
        weiter in der App eingegeben).
      </p>
      {owner ? (
        <form action={webshopHostAction} className="inline-form">
          <input type="hidden" name="id" value={id} />
          <label className="field">
            <span>Webshop (Hostname)</span>
            <input
              name="host"
              placeholder="shop.example.com"
              defaultValue={account.webshopHost ?? ''}
            />
          </label>
          <button className="btn" type="submit">
            Speichern
          </button>
        </form>
      ) : (
        <p>{account.webshopHost ?? 'kein Webshop'}</p>
      )}

      <h2>Bestellungen im Shop</h2>
      {orders.length === 0 ? (
        <p className="muted">Keine.</p>
      ) : (
        <ul>
          {orders.map((o) => (
            <li key={o.number}>
              {o.number} · {dateTime(o.createdAt)} · {STATUS_LABELS[o.status] ?? o.status} ·{' '}
              {formatEuro(o.totalCents)}
            </li>
          ))}
        </ul>
      )}

      <h2>Notiz</h2>
      <form action={adminNoteAction} className="stack">
        <input type="hidden" name="id" value={id} />
        <textarea name="note" rows={3} maxLength={2000} defaultValue={extra?.admin_note ?? ''} />
        <button className="btn btn--quiet" type="submit">
          Notiz speichern
        </button>
      </form>
    </AdminShell>
  );
}
