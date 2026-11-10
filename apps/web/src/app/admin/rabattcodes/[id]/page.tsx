import { notFound } from 'next/navigation';
import { formatEuro } from '@pokeshop/core/money';
import { discountCodeUses, formatPercent } from '@pokeshop/core/vouchers';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../../AdminShell';
import { CODE_SCOPE, dateTime } from '../../labels';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Rabattcode' };

export default async function CodePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin();
  const id = Number((await params).id);
  const [c] = Number.isSafeInteger(id)
    ? await db()<
        {
          id: number;
          code: string;
          campaign: string | null;
          kind: string;
          percent_bp: number | null;
          amount_cents: number | null;
          applies_to: string;
          note: string | null;
          created_by: string;
          created_at: Date;
          active: boolean;
        }[]
      >`SELECT id, code, campaign, kind, percent_bp, amount_cents, applies_to, note, created_by,
               created_at, active FROM discount_codes WHERE id = ${id}`
    : [];
  if (!c) notFound();
  const uses = await discountCodeUses(db(), c.id);
  return (
    <AdminShell user={user} active="codes">
      <p>
        <a href="/admin/rabattcodes">← Alle Rabattcodes</a>
      </p>
      <h1>
        <code>{c.code}</code>
      </h1>
      <p>
        {c.kind === 'percent' ? formatPercent(c.percent_bp!, 'de') : formatEuro(c.amount_cents!)} ·{' '}
        {CODE_SCOPE[c.applies_to]} · {c.active ? 'aktiv' : 'deaktiviert'}
        {c.campaign ? ` · Aktion ${c.campaign}` : ''}
      </p>
      <p className="muted">
        Angelegt von {c.created_by} am {dateTime(c.created_at)}
        {c.note ? ` · ${c.note}` : ''}
      </p>
      <h2>Bestellungen mit diesem Code</h2>
      {uses.length === 0 ? (
        <p className="muted">Noch nicht eingelöst.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Bestellung</th>
                <th>Art</th>
                <th>E-Mail</th>
                <th style={{ textAlign: 'right' }}>Rabatt</th>
                <th>Wann</th>
              </tr>
            </thead>
            <tbody>
              {uses.map((u) => (
                <tr key={u.order_id}>
                  <td>
                    <a href={`/admin/bestellungen/${u.order_id}`}>{u.number}</a>
                    {u.status === 'held' && <small className="muted"> (Zahlung offen)</small>}
                  </td>
                  <td>{u.kind === 'license' ? 'App-Lizenz' : 'Karten'}</td>
                  <td>{u.email}</td>
                  <td style={{ textAlign: 'right' }}>−{formatEuro(u.discount_cents)}</td>
                  <td>{dateTime(u.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
