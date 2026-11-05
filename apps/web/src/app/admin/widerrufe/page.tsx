import { listWithdrawals } from '@pokeshop/core/fulfilment';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import { withdrawalHandledAction } from '../order-actions';
import { dateTime, STATUS_LABELS } from '../labels';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Widerrufe' };

export default async function Withdrawals({
  searchParams,
}: {
  searchParams: Promise<{ all?: string; ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const all = sp.all === '1';
  const rows = await listWithdrawals(db(), !all);
  return (
    <AdminShell user={user} active="withdrawals" notice={sp}>
      <h1>Widerrufe</h1>
      <p className="muted">
        Eingänge über „Vertrag widerrufen“. Der Kunde hat die Eingangsbestätigung automatisch
        bekommen. Erstatten geht in der Bestellung, sobald die Karten zurück sind.{' '}
        {all ? <a href="?">Nur offene zeigen</a> : <a href="?all=1">Auch erledigte zeigen</a>}
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Eingang</th>
              <th>Kunde</th>
              <th>Bestellung</th>
              <th>Was</th>
              <th>Erledigt</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id}>
                <td>
                  {dateTime(w.received_at)}
                  <br />
                  <span className="muted">
                    {w.acknowledged_at ? 'Bestätigung gesendet' : 'Bestätigung ausstehend'}
                  </span>
                </td>
                <td>
                  {w.name}
                  <br />
                  <a href={`mailto:${w.email}`}>{w.email}</a>
                </td>
                <td>
                  {w.order_id ? (
                    <a href={`/admin/bestellungen/${w.order_id}`}>{w.order_number}</a>
                  ) : (
                    (w.order_number ?? <span className="muted">keine Angabe</span>)
                  )}
                  {w.order_status && (
                    <>
                      <br />
                      <span className="muted">{STATUS_LABELS[w.order_status]}</span>
                    </>
                  )}
                  {w.order_number && !w.order_id && (
                    <>
                      <br />
                      <span className="warn">Nummer unbekannt</span>
                    </>
                  )}
                </td>
                <td style={{ whiteSpace: 'pre-wrap' }}>
                  {w.items || 'ganze Bestellung'}
                  {w.message && <span className="muted">{`\n${w.message}`}</span>}
                </td>
                <td>
                  {w.handled_at ? (
                    <>
                      {dateTime(w.handled_at)}
                      <br />
                      <span className="muted">
                        {w.handled_by}
                        {w.note ? `: ${w.note}` : ''}
                      </span>
                    </>
                  ) : (
                    <form action={withdrawalHandledAction} className="stack-admin">
                      <input type="hidden" name="id" value={w.id} />
                      <input name="note" placeholder="Notiz (optional)" aria-label="Notiz" />
                      <button className="btn btn--quiet" type="submit">
                        Erledigt
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Keine offenen Widerrufe.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
