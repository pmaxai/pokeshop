import { notFound } from 'next/navigation';
import { formatEuro } from '@pokeshop/core/money';
import { voucherDetail } from '@pokeshop/core/vouchers';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../../AdminShell';
import { VOUCHER_MOVEMENT, VOUCHER_ORIGIN, VOUCHER_STATUS, dateTime } from '../../labels';
import { blockVoucherAction, cancelVoucherAction } from '../../voucher-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Gutschein' };

export default async function VoucherPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const id = Number((await params).id);
  const d = Number.isSafeInteger(id) ? await voucherDetail(db(), id) : null;
  if (!d) notFound();
  const v = d.voucher;
  const owner = user.role === 'owner';
  return (
    <AdminShell user={user} active="vouchers" notice={await searchParams}>
      <p>
        <a href="/admin/gutscheine">← Alle Gutscheine</a>
      </p>
      <h1>
        Gutschein <code>{v.code}</code>
      </h1>
      <div className="two-col">
        <section className="panel">
          <h2>{VOUCHER_ORIGIN[v.origin]}</h2>
          <dl className="plain">
            <dt>Wert</dt>
            <dd>{formatEuro(v.value_cents)}</dd>
            <dt>Restwert</dt>
            <dd>
              <strong>{formatEuro(v.balance_cents)}</strong>
            </dd>
            <dt>Status</dt>
            <dd>{VOUCHER_STATUS[v.status]}</dd>
            <dt>Gültig bis</dt>
            <dd>{v.expires_at ? dateTime(v.expires_at) : 'ohne Ablauf'}</dd>
            {v.origin === 'sold' ? (
              <>
                <dt>Bezahlt</dt>
                <dd>
                  {formatEuro(v.paid_cents ?? 0)} am {dateTime(v.paid_at)} ·{' '}
                  <a href={`/admin/bestellungen/${v.order_id}`}>Bestellung {v.order_number}</a>
                  <br />
                  <small className="muted">{v.order_email}</small>
                </dd>
              </>
            ) : (
              <>
                <dt>Ausgegeben von</dt>
                <dd>
                  {v.created_by} am {dateTime(v.created_at)}
                  <br />
                  <small className="muted">ohne Einnahme – beim Einlösen ein Rabatt</small>
                </dd>
                {v.note && (
                  <>
                    <dt>Für / wofür</dt>
                    <dd>{v.note}</dd>
                  </>
                )}
              </>
            )}
            {v.recipient_name && (
              <>
                <dt>Name auf dem Gutschein</dt>
                <dd>{v.recipient_name}</dd>
              </>
            )}
            {v.message && (
              <>
                <dt>Nachricht</dt>
                <dd>„{v.message}“</dd>
              </>
            )}
          </dl>
          <p>
            <a className="btn" href={`/admin/gutscheine/${v.id}/pdf`}>
              Gutschein als PDF
            </a>
          </p>
        </section>
        {owner && v.status !== 'cancelled' && (
          <section className="panel panel--action">
            <h2>Aktionen</h2>
            <form action={blockVoucherAction} className="inline-form">
              <input type="hidden" name="id" value={v.id} />
              <input type="hidden" name="blocked" value={v.status === 'blocked' ? '0' : '1'} />
              <button className="btn" type="submit">
                {v.status === 'blocked' ? 'Wieder freigeben' : 'Sperren'}
              </button>
            </form>
            <p className="muted small">
              Gesperrt lässt er sich nicht einlösen (z. B. wenn der Code in falsche Hände kam). Der
              Restwert bleibt.
            </p>
            {v.origin === 'sold' && v.balance_cents > 0 && (
              <form action={cancelVoucherAction} className="stack-admin">
                <input type="hidden" name="id" value={v.id} />
                <h3>Stornieren und erstatten</h3>
                <p className="small">
                  Für einen Widerruf: Der Restwert ({formatEuro(v.balance_cents)}) geht über Stripe
                  zurück, der Gutschein wird ungültig.
                </p>
                <label className="field">
                  <span>Grund (intern)</span>
                  <input name="reason" maxLength={500} placeholder="z. B. Widerruf per E-Mail" />
                </label>
                <label className="check">
                  <input type="checkbox" name="confirm" /> Ja, stornieren und erstatten
                </label>
                <button className="btn danger" type="submit">
                  Stornieren und erstatten
                </button>
              </form>
            )}
          </section>
        )}
      </div>

      <h2>Bewegungen</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Wann</th>
              <th>Was</th>
              <th>Bestellung</th>
              <th style={{ textAlign: 'right' }}>Betrag</th>
              <th>Wer</th>
            </tr>
          </thead>
          <tbody>
            {d.movements.map((m) => (
              <tr key={m.id}>
                <td>{dateTime(m.created_at)}</td>
                <td>{VOUCHER_MOVEMENT[m.kind] ?? m.kind}</td>
                <td>
                  {m.order_id ? (
                    <a href={`/admin/bestellungen/${m.order_id}`}>{m.order_number}</a>
                  ) : (
                    '–'
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {m.amount_cents > 0 ? '+' : ''}
                  {formatEuro(m.amount_cents)}
                </td>
                <td>{m.actor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
