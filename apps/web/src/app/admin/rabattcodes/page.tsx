import { formatEuro } from '@pokeshop/core/money';
import { formatPercent, listDiscountCodes } from '@pokeshop/core/vouchers';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import { CODE_SCOPE, dateTime } from '../labels';
import { createDiscountCodesAction, toggleDiscountCodeAction } from '../voucher-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Rabattcodes' };

type SP = { ok?: string; err?: string; q?: string; campaign?: string };

export default async function Codes({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const { rows, total, campaigns } = await listDiscountCodes(db(), {
    q: sp.q,
    campaign: sp.campaign,
    limit: 200,
  });
  const owner = user.role === 'owner';
  const self = `/admin/rabattcodes${sp.campaign ? `?campaign=${encodeURIComponent(sp.campaign)}` : ''}`;
  return (
    <AdminShell user={user} active="codes" notice={sp}>
      <h1>Rabattcodes</h1>
      <p style={{ maxWidth: '70ch' }}>
        Ein Code wie „CHRISTMAS“ für eine Aktion, oder viele Einmal-Codes für Freunde und Flyer.
        Rabattcodes senken den Preis – für Karten (Shop), App-Lizenzen (GmbH) oder beides. Pro
        Bestellung gilt einer; Gutscheine lassen sich dazu einlösen.
      </p>

      {owner && (
        <section className="panel">
          <h2>Neuer Code</h2>
          <form
            action={createDiscountCodesAction}
            className="form-grid"
            style={{ alignItems: 'start' }}
          >
            <label className="field">
              <span>Code</span>
              <input
                name="code"
                maxLength={40}
                placeholder="z. B. CHRISTMAS"
                pattern="[A-Za-z0-9][A-Za-z0-9_\-]{2,39}"
              />
              <small className="muted">
                Groß-/Kleinschreibung egal. Leer lassen, wenn du unten mehrere Codes erzeugst.
              </small>
            </label>
            <label className="field">
              <span>Oder: Anzahl Einmal-Codes</span>
              <input name="count" type="number" min={1} max={500} defaultValue={1} />
              <small className="muted">
                Ab 2: jeder Code einmal einlösbar, z. B. FREUND-7KQ4MP.
              </small>
            </label>
            <label className="field">
              <span>Präfix für Einmal-Codes</span>
              <input name="prefix" maxLength={12} placeholder="z. B. FREUND" />
            </label>
            <label className="field">
              <span>Aktion (zum Zusammenfassen)</span>
              <input name="campaign" maxLength={80} placeholder="z. B. Weihnachten 2026" />
            </label>
            <label className="field">
              <span>Art</span>
              <select name="kind" defaultValue="percent">
                <option value="percent">Prozent</option>
                <option value="amount">Betrag in €</option>
              </select>
            </label>
            <label className="field">
              <span>Prozent</span>
              <input name="percent" inputMode="decimal" placeholder="z. B. 20 (100 = gratis)" />
            </label>
            <label className="field">
              <span>Betrag (€)</span>
              <input name="amount" inputMode="decimal" placeholder="z. B. 5" />
            </label>
            <label className="field">
              <span>Gilt für</span>
              <select name="applies_to" defaultValue="cards">
                <option value="cards">Karten</option>
                <option value="licenses">App-Lizenzen</option>
                <option value="both">Karten und Lizenzen</option>
              </select>
            </label>
            <label className="field">
              <span>Karten: Mindestwert (€)</span>
              <input name="min_goods" inputMode="decimal" placeholder="optional" />
            </label>
            <label className="field">
              <span>Lizenzen: höchstens so viele rabattiert</span>
              <input
                name="max_licenses"
                type="number"
                min={1}
                max={50}
                placeholder="optional, z. B. 1"
              />
              <small className="muted">„100 %“ und „1“ = eine Lizenz gratis.</small>
            </label>
            <label className="field">
              <span>Wie oft insgesamt einlösbar</span>
              <input name="max_uses" type="number" min={1} placeholder="leer = unbegrenzt" />
            </label>
            <label className="field">
              <span>Gültig ab</span>
              <input name="valid_from" type="date" />
            </label>
            <label className="field">
              <span>Gültig bis</span>
              <input name="valid_until" type="date" />
            </label>
            <label className="field">
              <span>Notiz (intern)</span>
              <input name="note" maxLength={300} />
            </label>
            <label className="check">
              <input type="checkbox" name="once" defaultChecked /> Pro Kunde (E-Mail) nur einmal
            </label>
            <div>
              <button className="btn btn--accent" type="submit">
                Anlegen
              </button>
            </div>
          </form>
        </section>
      )}

      {campaigns.length > 0 && (
        <section>
          <h2>Aktionen</h2>
          <ul className="plain">
            {campaigns.map((c) => (
              <li key={c.campaign}>
                <a href={`/admin/rabattcodes?campaign=${encodeURIComponent(c.campaign)}`}>
                  {c.campaign}
                </a>{' '}
                <span className="muted">
                  {c.n} {c.n === 1 ? 'Code' : 'Codes'}, {c.used}× eingelöst
                </span>{' '}
                ·{' '}
                <a href={`/admin/rabattcodes/export?campaign=${encodeURIComponent(c.campaign)}`}>
                  Codes als CSV
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="toolbar">
        <h2 style={{ margin: 0 }}>
          {sp.campaign ? `Aktion „${sp.campaign}“` : 'Alle Codes'}{' '}
          <span className="muted">({total})</span>
        </h2>
        <form method="get" className="inline-form">
          {sp.campaign && <input type="hidden" name="campaign" value={sp.campaign} />}
          <label className="field">
            <span className="visually-hidden">Suche</span>
            <input
              name="q"
              defaultValue={sp.q ?? ''}
              placeholder="Code, Aktion, Notiz …"
              style={{ minWidth: '16rem' }}
            />
          </label>
          <button className="btn" type="submit">
            Suchen
          </button>
        </form>
      </div>
      {sp.campaign && owner && rows.length > 0 && (
        <form
          action={toggleDiscountCodeAction}
          className="inline-form"
          style={{ marginBottom: 'var(--s-3)' }}
        >
          <input type="hidden" name="ids" value={rows.map((r) => r.id).join(',')} />
          <input type="hidden" name="active" value="0" />
          <input type="hidden" name="back" value={self} />
          <button className="btn" type="submit">
            Alle Codes dieser Aktion deaktivieren
          </button>
        </form>
      )}
      {rows.length === 0 ? (
        <p className="muted">Noch keine Codes.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Rabatt</th>
                <th>Gilt für</th>
                <th>Eingelöst</th>
                <th>Gültig</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <a href={`/admin/rabattcodes/${c.id}`}>
                      <code>{c.code}</code>
                    </a>
                    {c.campaign && (
                      <>
                        <br />
                        <small className="muted">{c.campaign}</small>
                      </>
                    )}
                  </td>
                  <td>
                    {c.kind === 'percent'
                      ? formatPercent(c.percent_bp!, 'de')
                      : formatEuro(c.amount_cents!)}
                    {c.max_licenses && (
                      <small className="muted"> auf höchstens {c.max_licenses} Lizenz(en)</small>
                    )}
                    {c.min_goods_cents > 0 && (
                      <small className="muted"> ab {formatEuro(c.min_goods_cents)}</small>
                    )}
                  </td>
                  <td>{CODE_SCOPE[c.applies_to]}</td>
                  <td>
                    {c.used}
                    {c.max_uses ? ` / ${c.max_uses}` : ''}
                    {c.held > 0 && <small className="muted"> (+{c.held} offen)</small>}
                    <br />
                    <small className="muted">−{formatEuro(c.discount_total)}</small>
                  </td>
                  <td>
                    {c.valid_from || c.valid_until ? (
                      <small>
                        {c.valid_from ? `ab ${dateTime(c.valid_from)}` : ''}
                        {c.valid_until ? ` bis ${dateTime(c.valid_until)}` : ''}
                      </small>
                    ) : (
                      <small className="muted">immer</small>
                    )}
                    {c.once_per_customer && (
                      <>
                        <br />
                        <small className="muted">einmal pro Kunde</small>
                      </>
                    )}
                  </td>
                  <td>{c.active ? 'Aktiv' : 'Deaktiviert'}</td>
                  <td>
                    {owner && (
                      <form action={toggleDiscountCodeAction}>
                        <input type="hidden" name="ids" value={c.id} />
                        <input type="hidden" name="active" value={c.active ? '0' : '1'} />
                        <input type="hidden" name="back" value={self} />
                        <button className="linklike" type="submit">
                          {c.active ? 'Deaktivieren' : 'Aktivieren'}
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
    </AdminShell>
  );
}
