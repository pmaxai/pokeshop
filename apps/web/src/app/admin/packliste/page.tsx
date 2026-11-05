import { formatEuro } from '@pokeshop/core';
import { pickList } from '@pokeshop/core/fulfilment';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import { PrintButton } from './PrintButton';
import { dateTime, SHIPPING_LABELS } from '../labels';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Packliste' };

const FINISH: Record<string, string> = { normal: '', holo: 'Holo', reverse_holo: 'Reverse Holo' };
const countryLine = (code: string | undefined) =>
  // Postal rule: no country line within Austria, otherwise the country name in capitals.
  !code || code === 'AT'
    ? null
    : (new Intl.DisplayNames(['de-AT'], { type: 'region' }).of(code) ?? code).toUpperCase();

export default async function PickListPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const user = await requireAdmin();
  const ids = ((await searchParams).ids ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .slice(0, 200);
  const { lines, slips } = await pickList(db(), ids);
  const copies = lines.reduce((a, l) => a + l.quantity, 0);
  return (
    <AdminShell user={user} active="orders">
      <div className="no-print toolbar">
        <PrintButton />
        <a href="/admin/bestellungen?view=packing">Zu den Bestellungen in Arbeit</a>
      </div>
      <section className="pick">
        <h1>
          Packliste · {slips.length} {slips.length === 1 ? 'Bestellung' : 'Bestellungen'} · {copies}{' '}
          Karten
        </h1>
        <p className="muted">
          Erstellt {dateTime(new Date())} – nach Box sortiert. Abhaken, was im Kuvert ist.
        </p>
        <table className="table pick-table">
          <thead>
            <tr>
              <th>Box</th>
              <th className="r">Stück</th>
              <th>Karte</th>
              <th>Sprache · Zustand</th>
              <th>Bestellung</th>
              <th aria-label="erledigt" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="pick-box">{l.box}</td>
                <td className="r">
                  <strong>{l.quantity}</strong>
                </td>
                <td>
                  <strong>{l.name}</strong> {l.cardNumber}
                  <br />
                  <span className="muted">
                    {l.setName} {FINISH[l.finish] ? `· ${FINISH[l.finish]}` : ''}
                  </span>
                </td>
                <td>
                  {l.cardLanguage} · {l.condition}
                </td>
                <td>{l.orderNumber}</td>
                <td>
                  <span className="tick" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {slips.map((s) => (
        <section key={s.id} className="slip">
          <div className="slip__head">
            <div>
              <h2>{s.number}</h2>
              <p className="muted">
                bezahlt {dateTime(s.paidAt)} · {formatEuro(s.totalCents)}
              </p>
            </div>
            <p
              className={
                s.shippingMethod === 'standard'
                  ? 'slip__method'
                  : 'slip__method slip__method--alert'
              }
            >
              {s.shippingMethod === 'insured'
                ? 'VERSICHERT VERSENDEN'
                : s.shippingMethod === 'tracked'
                  ? 'MIT SENDUNGSNUMMER VERSENDEN'
                  : SHIPPING_LABELS.standard}
            </p>
          </div>
          <address className="slip__address">
            {[
              s.address.company,
              s.address.name,
              s.address.street,
              `${s.address.postcode ?? ''} ${s.address.city ?? ''}`,
              s.address.country,
            ]
              .filter(Boolean)
              .map((l, i) => (
                <span key={i}>
                  {l}
                  <br />
                </span>
              ))}
          </address>
          <table className="table">
            <tbody>
              {s.lines.map((l, i) => (
                <tr key={i}>
                  <td className="pick-box">{l.box}</td>
                  <td className="r">{l.quantity}×</td>
                  <td>
                    {l.name} {l.cardNumber}{' '}
                    <span className="muted">
                      · {l.setName} · {l.cardLanguage} · {l.condition}
                    </span>
                  </td>
                  <td>
                    <span className="tick" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {slips.length === 0 && <p>Keine Bestellungen gewählt.</p>}
    </AdminShell>
  );
}
