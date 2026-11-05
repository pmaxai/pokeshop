import { countrySettings, generalSettings } from '@pokeshop/core/shop-settings';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import { saveCountriesAction, saveSettingsAction } from '../order-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Einstellungen' };

const euro = (c: number | null) => (c === null ? '' : (c / 100).toFixed(2).replace('.', ','));
const pct = (bp: number) => String(bp / 100).replace('.', ',');

export default async function Settings({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string; alle?: string }>;
}) {
  const user = await requireAdmin('owner');
  const sp = await searchParams;
  const [countries, general] = await Promise.all([countrySettings(db()), generalSettings(db())]);
  const names = new Intl.DisplayNames(['de-AT'], { type: 'region' });
  const shown =
    sp.alle === '1' ? countries : countries.filter((c) => c.delivery_enabled || c.is_eu);
  return (
    <AdminShell user={user} active="settings" notice={sp}>
      <h1>Einstellungen</h1>

      <section className="panel">
        <h2>Allgemein</h2>
        <form action={saveSettingsAction} className="stack-admin">
          <div className="form-grid">
            <label className="field">
              <span>Wertvolle Karte ab Preis über (€)</span>
              <input
                name="threshold"
                defaultValue={euro(general.high_value_threshold_cents)}
                inputMode="decimal"
              />
              <small className="muted">
                Karten über diesem Preis werden versichert verschickt. Leer = nie.
              </small>
            </label>
            <label className="field">
              <span>Reservierung beim Bezahlen (Minuten)</span>
              <input
                name="reservation"
                type="number"
                min={5}
                max={30}
                defaultValue={general.reservation_minutes}
              />
              <small className="muted">
                Im Shop und in den AGB stehen 10 Minuten – bei Änderung die Texte anpassen.
              </small>
            </label>
            <label className="field">
              <span>Shop-E-Mails gehen an</span>
              <input name="recipients" defaultValue={general.admin_alert_recipients.join(', ')} />
              <small className="muted">
                Neue Bestellungen, Widerrufe, Hinweise. Mehrere mit Komma trennen.
              </small>
            </label>
            <label className="field">
              <span>Sendungsverfolgung (Link)</span>
              <input name="tracking_url" defaultValue={general.tracking_url} />
              <small className="muted">
                {'{number}'} wird durch die Sendungsnummer ersetzt. Einmal mit einer echten Nummer
                prüfen.
              </small>
            </label>
          </div>
          <p>
            <button className="btn btn--accent" type="submit">
              Speichern
            </button>
          </p>
        </form>
      </section>

      <section className="panel">
        <h2>Lieferländer</h2>
        <p className="muted">
          Mindestbestellwert gilt für den Warenwert. Versichert wird bis zum Bestellwert in
          „Versicherung bis“; darüber geht die Sendung ohne Versicherung mit Sendungsnummer.{' '}
          {sp.alle === '1' ? (
            <a href="?">Nur EU und aktive zeigen</a>
          ) : (
            <a href="?alle=1">Alle Länder zeigen</a>
          )}
        </p>
        <form action={saveCountriesAction}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Land</th>
                  <th>Liefern</th>
                  <th>Mindestbestellwert €</th>
                  <th>Versicherung %</th>
                  <th>mind. €</th>
                  <th>Versicherung bis €</th>
                  <th>Lieferzeit (de / en)</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.code}>
                    <td>
                      <input type="hidden" name="code" value={c.code} />
                      <strong>{names.of(c.code)}</strong> <span className="muted">{c.code}</span>
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        name={`enabled_${c.code}`}
                        defaultChecked={c.delivery_enabled}
                        aria-label={`${c.code} beliefern`}
                      />
                    </td>
                    <td>
                      <input
                        name={`min_${c.code}`}
                        defaultValue={euro(c.min_order_cents)}
                        size={7}
                        inputMode="decimal"
                        aria-label={`${c.code} Mindestbestellwert`}
                      />
                    </td>
                    <td>
                      <input
                        name={`rate_${c.code}`}
                        defaultValue={pct(c.insured_rate_bp)}
                        size={4}
                        inputMode="decimal"
                        aria-label={`${c.code} Versicherung Prozent`}
                      />
                    </td>
                    <td>
                      <input
                        name={`insmin_${c.code}`}
                        defaultValue={euro(c.insured_minimum_cents)}
                        size={6}
                        inputMode="decimal"
                        aria-label={`${c.code} Versicherung mindestens`}
                      />
                    </td>
                    <td>
                      <input
                        name={`insmax_${c.code}`}
                        defaultValue={euro(c.insured_max_order_cents)}
                        size={7}
                        inputMode="decimal"
                        aria-label={`${c.code} Versicherung bis`}
                      />
                    </td>
                    <td>
                      <input
                        name={`time_de_${c.code}`}
                        defaultValue={c.delivery_time_de ?? ''}
                        size={12}
                        placeholder="1–3 Werktage"
                        aria-label={`${c.code} Lieferzeit deutsch`}
                      />{' '}
                      <input
                        name={`time_en_${c.code}`}
                        defaultValue={c.delivery_time_en ?? ''}
                        size={12}
                        placeholder="1–3 working days"
                        aria-label={`${c.code} Lieferzeit englisch`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ marginTop: 'var(--s-4)' }}>
            <button className="btn btn--accent" type="submit">
              Lieferländer speichern
            </button>
          </p>
          <p className="muted">
            Ein neues Lieferland braucht oft auch Anpassungen in den AGB (Lieferzeiten) – bitte
            mitdenken.
          </p>
        </form>
      </section>
    </AdminShell>
  );
}
