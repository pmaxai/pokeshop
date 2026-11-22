import { APP_NAME, appStores, gmbhSeller } from '@pokeshop/core/app';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import { saveAppSettingsAction } from '../app-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'App' };

export default async function AppAdmin({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const [stores, seller] = await Promise.all([appStores(db()), gmbhSeller(db())]);
  const owner = user.role === 'owner';

  return (
    <AdminShell user={user} active="app" notice={await searchParams}>
      <h1>App: {APP_NAME}</h1>
      <p>
        <a href="/app" target="_blank" rel="noreferrer">
          App-Seite im Shop
        </a>
        {' · '}
        <a href="/admin/kunden/stores">Produkte in Google Play und im App Store</a>
        {' · '}
        <a href="/admin/kunden">Kunden & Abos</a>
      </p>

      <section className="panel">
        <h2>Store-Links und Absender</h2>
        <p className="muted">
          Die App gibt es nur noch über die Stores. Die Links zeigen die App-Seite, die Geräte-Seite
          im Kundenkonto und die Links von Creator-Codes (mit dem Code im Play-Link). Ohne
          App-Store-Link steht auf der App-Seite „iPhone: bald im App Store“.
        </p>
        <form action={saveAppSettingsAction} className="form-grid" style={{ alignItems: 'start' }}>
          <label className="field">
            <span>Google Play</span>
            <input
              name="play_store_url"
              type="url"
              defaultValue={stores.play ?? ''}
              placeholder="https://play.google.com/store/apps/details?id=…"
              disabled={!owner}
            />
          </label>
          <label className="field">
            <span>App Store</span>
            <input
              name="app_store_url"
              type="url"
              defaultValue={stores.apple ?? ''}
              placeholder="https://apps.apple.com/at/app/overpriced-cardboard/id…"
              disabled={!owner}
            />
          </label>
          <label className="field">
            <span>Absender der E-Mails der {seller.name}</span>
            <input
              name="sender_email"
              type="email"
              defaultValue={seller.email}
              disabled={!owner}
              required
            />
            <small className="muted">
              Abo-E-Mails (Willkommen, Rechnung, Zahlung fehlgeschlagen …) kommen von hier. Postfach
              im selben Microsoft-365-Konto wie bestellung@; Antworten gehen auch dorthin.
            </small>
          </label>
          {owner && (
            <div>
              <button className="btn btn--accent" type="submit">
                Speichern
              </button>
            </div>
          )}
        </form>
      </section>
    </AdminShell>
  );
}
