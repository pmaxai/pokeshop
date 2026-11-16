import { discountLabel, listAffiliates } from '@pokeshop/core/affiliates';
import { config, db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import { saveAffiliateAction, saveAffiliateLinkAction } from '../affiliate-actions';
import { periodOf } from './period';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Affiliates' };

type SP = { ok?: string; err?: string; from?: string; to?: string };

/** Influencers, their links (code, discount) and the export of the registrations for payouts. */
export default async function Affiliates({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const period = periodOf(sp.from, sp.to);
  const affiliates = await listAffiliates(db(), period);
  const owner = user.role === 'owner';
  const exportUrl = `/admin/affiliates/export?from=${period.fromDay}&to=${period.toDay}`;

  const field = (
    name: string,
    label: string,
    value: string | number | null | undefined,
    opts: { hint?: string; type?: string; required?: boolean; max?: number; min?: number } = {},
  ) => (
    <label className="field" key={name}>
      <span>{label}</span>
      <input
        name={name}
        type={opts.type ?? 'text'}
        defaultValue={value ?? ''}
        required={opts.required}
        min={opts.min}
        max={opts.max}
        autoComplete="off"
        spellCheck={false}
      />
      {opts.hint && <small className="muted">{opts.hint}</small>}
    </label>
  );
  const affiliateFields = (a?: (typeof affiliates)[number]) => (
    <>
      {field('name', 'Name (Influencer, Kanal)', a?.name, { required: true })}
      {field('email', 'E-Mail', a?.email, { type: 'email' })}
      {field('country', 'Land (ISO, z. B. AT, US)', a?.country, {
        hint: 'Für die Auszahlung; Influencer außerhalb der EU sind möglich.',
      })}
      {field('commission', 'Vergütung', a?.commission, {
        hint: 'Freitext, z. B. „20 % des ersten Jahres“ – die Auszahlung erfolgt von Hand.',
      })}
      <label className="field">
        <span>Auszahlung (Konto, PayPal …)</span>
        <textarea name="payout_details" rows={2} defaultValue={a?.payoutDetails ?? ''} />
      </label>
      <label className="field">
        <span>Notiz</span>
        <textarea name="note" rows={2} defaultValue={a?.note ?? ''} />
      </label>
    </>
  );
  const linkFields = (l?: (typeof affiliates)[number]['links'][number]) => (
    <>
      {field('code', 'Code', l?.code, {
        required: true,
        hint: '3–30 Zeichen: Buchstaben, Ziffern, Bindestrich. Groß/klein egal.',
      })}
      {field('label', 'Bezeichnung', l?.label, { hint: 'z. B. „YouTube“, „Instagram“' })}
      {field('discount_percent', 'Rabatt auf der Website (%)', l?.discountPercent ?? 0, {
        type: 'number',
        min: 0,
        max: 90,
        hint: '0 = kein Rabatt. Stripe-Gutschein beim ersten Abo.',
      })}
      {field('discount_months', 'für Monate', l?.discountMonths, {
        type: 'number',
        min: 1,
        max: 36,
        hint: 'leer = solange das Abo läuft',
      })}
      {field('google_offer_id', 'Google-Play-Angebot (ID)', l?.googleOfferId, {
        hint: 'In der Play Console unter jedem Basis-Abo mit dieser ID anlegen, Teilnahme „Vom Entwickler festgelegt“, gleicher Rabatt.',
      })}
    </>
  );

  return (
    <AdminShell user={user} active="affiliates" notice={sp}>
      <h1>Affiliates</h1>
      <p style={{ maxWidth: '72ch' }}>
        Influencer bekommen Links wie <code>{config.baseUrl}/r/CODE</code> oder nennen den Code
        einfach. Wer damit ein Konto anlegt oder sich anmeldet, bevor er zum ersten Mal ein Abo
        bezahlt, wird dem Link zugeordnet (der erste Code zählt) und bekommt beim ersten Abo den
        Rabatt des Links: auf der Website als Stripe-Gutschein, in der App als Google-Play-Angebot –
        das funktioniert weltweit, auch außerhalb der EU. Die Auszahlung an die Influencer machst du
        von Hand anhand des Exports.
      </p>

      <section className="panel">
        <h2>Zeitraum und Export</h2>
        <form method="get" className="form-grid" style={{ alignItems: 'end' }}>
          <label className="field">
            <span>Von</span>
            <input type="date" name="from" defaultValue={period.fromDay} />
          </label>
          <label className="field">
            <span>Bis (einschließlich)</span>
            <input type="date" name="to" defaultValue={period.toDay} />
          </label>
          <div>
            <button className="btn btn--quiet" type="submit">
              Zahlen anzeigen
            </button>
          </div>
        </form>
        <p>
          <a className="btn" href={exportUrl}>
            CSV herunterladen ({period.fromDay} bis {period.toDay})
          </a>
        </p>
        <p className="muted small" style={{ maxWidth: '72ch' }}>
          Eine Zeile je Registrierung im Zeitraum, für alle Influencer: Influencer, Code, Rabatt,
          Weg (Link, Code, App), Konto-ID, erstes bezahltes Abo (wann, Website oder Google Play,
          Plan, Laufzeit, Land), ob der Rabatt genutzt wurde und ob das Abo heute läuft. Gelöschte
          Konten bleiben drin (ohne Daten). Für Excel: Semikolon, UTF-8.
        </p>
      </section>

      {owner && (
        <details className="panel">
          <summary>
            <strong>Neuer Influencer</strong>
          </summary>
          <form action={saveAffiliateAction} className="form-grid" style={{ alignItems: 'start' }}>
            {affiliateFields()}
            <div>
              <button className="btn btn--accent" type="submit">
                Anlegen
              </button>
            </div>
          </form>
        </details>
      )}

      {affiliates.length === 0 && <p className="muted">Noch keine Influencer angelegt.</p>}

      {affiliates.map((a) => (
        <section key={a.id} className="panel" id={`aff-${a.id}`}>
          <h2>
            {a.name}
            {!a.active && <span className="muted"> (inaktiv)</span>}
          </h2>
          <p className="muted small">
            {[a.country, a.email, a.commission ? `Vergütung: ${a.commission}` : null]
              .filter(Boolean)
              .join(' · ') || 'Keine Angaben'}
          </p>
          {a.links.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Code / Link</th>
                    <th>Rabatt</th>
                    <th className="r">Registriert im Zeitraum</th>
                    <th className="r">Erstes Abo im Zeitraum</th>
                    <th className="r">Gesamt</th>
                  </tr>
                </thead>
                <tbody>
                  {a.links.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <strong>{l.code}</strong>
                        {l.label && <span className="muted"> · {l.label}</span>}
                        {!l.active && <span className="muted"> (inaktiv)</span>}
                        <div className="muted small">
                          <code>
                            {config.baseUrl}/r/{l.code}
                          </code>
                        </div>
                      </td>
                      <td>{discountLabel(l.discountPercent, l.discountMonths, l.googleOfferId)}</td>
                      <td className="r">{l.registrations}</td>
                      <td className="r">{l.purchases}</td>
                      <td className="r">{l.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Noch kein Link.</p>
          )}
          {owner && (
            <>
              <details>
                <summary>Neuer Link</summary>
                <form
                  action={saveAffiliateLinkAction}
                  className="form-grid"
                  style={{ alignItems: 'start' }}
                >
                  <input type="hidden" name="affiliate_id" value={a.id} />
                  {linkFields()}
                  <div>
                    <button className="btn btn--accent" type="submit">
                      Link anlegen
                    </button>
                  </div>
                </form>
              </details>
              {a.links.map((l) => (
                <details key={l.id}>
                  <summary>Link {l.code} bearbeiten</summary>
                  <form
                    action={saveAffiliateLinkAction}
                    className="form-grid"
                    style={{ alignItems: 'start' }}
                  >
                    <input type="hidden" name="affiliate_id" value={a.id} />
                    <input type="hidden" name="id" value={l.id} />
                    {linkFields(l)}
                    <label className="check">
                      <input type="checkbox" name="active" defaultChecked={l.active} /> aktiv
                    </label>
                    <div>
                      <button className="btn" type="submit">
                        Speichern
                      </button>
                    </div>
                  </form>
                  <p className="muted small">
                    Einen Code zu ändern, macht den alten Link ungültig; bisherige Registrierungen
                    bleiben beim Link.
                  </p>
                </details>
              ))}
              <details>
                <summary>{a.name} bearbeiten</summary>
                <form
                  action={saveAffiliateAction}
                  className="form-grid"
                  style={{ alignItems: 'start' }}
                >
                  <input type="hidden" name="id" value={a.id} />
                  {affiliateFields(a)}
                  <label className="check">
                    <input type="checkbox" name="active" defaultChecked={a.active} /> aktiv
                    (inaktiv: keine neuen Registrierungen, kein Rabatt mehr)
                  </label>
                  <div>
                    <button className="btn" type="submit">
                      Speichern
                    </button>
                  </div>
                </form>
              </details>
            </>
          )}
        </section>
      ))}
    </AdminShell>
  );
}
