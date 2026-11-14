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
import { dateTime, STATUS_LABELS, subscriptionStatusLabel as statusLabel } from '../../labels';
import {
  adminCancelAction,
  adminNoteAction,
  adminRemoveDeviceAction,
  endComplimentaryAction,
  grantComplimentaryAction,
  webshopHostAction,
} from '../../customer-actions';

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
