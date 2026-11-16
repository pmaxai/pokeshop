import { storeProducts } from '@pokeshop/core/store';
import { config, db, googlePlay, pubSubAuth } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../../AdminShell';
import { saveStoreProductsAction } from '../../customer-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'App-Stores' };

/** The store products of the plans, and whether Google Play is set up. */
export default async function Stores({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireAdmin('owner');
  const sp = await searchParams;
  const p = await storeProducts(db());
  const pubsub = pubSubAuth();
  const check = (ok: boolean, text: string, missing: string) => (
    <li>
      {ok ? '✓' : '✗'} {ok ? text : missing}
    </li>
  );
  const input = (name: string, label: string, value: string | null, hint?: string) => (
    <label className="field" key={name}>
      <span>{label}</span>
      <input name={name} defaultValue={value ?? ''} autoComplete="off" spellCheck={false} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
  return (
    <AdminShell user={user} active="customers" notice={sp}>
      <p>
        <a href="/admin/kunden">← Kunden & Abos</a>
      </p>
      <h1>App-Stores</h1>
      <p>
        Collector und Creator gibt es auch in Google Play (später im App Store), monatlich und
        jährlich. Die Preise stellst du in der Play Console je Land ein; hier stehen nur die
        Produkt-IDs, damit der Server einen Kauf dem Abo zuordnet und die App die Angebote kennt.
        Eine einmal angelegte Produkt-ID kann im Store nie wieder verwendet werden. Bis zu vier
        zusätzliche Geräte verkauft die App als Add-ons zum Abo; weitere Geräte bucht man im Konto
        (Stripe), sie enden mit dem Store-Abo.
      </p>
      <h2>Einrichtung</h2>
      <ul className="plain">
        {check(
          config.googleClientIds.length > 0,
          `Anmelden mit Google: ${config.googleClientIds.length} OAuth-Client(s)`,
          'Anmelden mit Google: GOOGLE_OAUTH_CLIENT_IDS fehlt',
        )}
        {check(
          googlePlay() !== null,
          'Google Play Developer API: Dienstkonto eingerichtet',
          'Google Play Developer API: GOOGLE_PLAY_SERVICE_ACCOUNT fehlt',
        )}
        <li>
          Pub/Sub-Push an <code>{config.baseUrl}/api/store/google/notifications</code>, Audience{' '}
          <code>{pubsub.audience}</code>
          {pubsub.email ? (
            <>
              , Dienstkonto <code>{pubsub.email}</code>
            </>
          ) : (
            ' (GOOGLE_PUBSUB_SERVICE_ACCOUNT nicht gesetzt: jedes Google-Konto mit dieser Audience wird angenommen)'
          )}
        </li>
        {config.review && (
          <li>
            Review-Konto <code>{config.review.email}</code> mit festem Code (REVIEW_LOGIN_CODE)
          </li>
        )}
        {config.storeTestHooks && <li>Test-Hooks sind an (nur Staging).</li>}
      </ul>
      <form action={saveStoreProductsAction} className="store-form">
        <h2>Google Play</h2>
        <div className="store-plans">
          {(['collector', 'creator'] as const).map((plan) => (
            <fieldset key={plan}>
              <legend>{plan === 'collector' ? 'Collector' : 'Creator'}</legend>
              {input(
                `google.${plan}.product_id`,
                'Abo (Produkt-ID)',
                p.google[plan].product_id,
                'Kleinbuchstaben, Ziffern, Punkt, Unterstrich',
              )}
              {input(
                `google.${plan}.monthly`,
                'Basis-Abo monatlich',
                p.google[plan].base_plans.monthly,
              )}
              {input(
                `google.${plan}.yearly`,
                'Basis-Abo jährlich',
                p.google[plan].base_plans.yearly,
              )}
              <p className="small muted">
                {`Zusätzliche Geräte in der App: je Gerät ein eigenes Abo-Produkt (Add-on) mit denselben Basis-Abo-IDs, Preis wie ein ${plan === 'collector' ? 'Collector' : 'Creator'}-Gerät. Leer = in der App nicht verkauft.`}
              </p>
              {[1, 2, 3, 4].map((i) =>
                input(
                  `google.${plan}.device_${i}`,
                  `Gerät ${i} (Produkt-ID)`,
                  p.google[plan].device_product_ids[i - 1] ?? null,
                ),
              )}
            </fieldset>
          ))}
        </div>
        <h2>App Store</h2>
        <p className="muted">Kommt mit der iOS-App; bis dahin leer lassen.</p>
        <div className="store-plans">
          {(['collector', 'creator'] as const).map((plan) => (
            <fieldset key={plan}>
              <legend>{plan === 'collector' ? 'Collector' : 'Creator'}</legend>
              {input(`apple.${plan}.monthly`, 'Produkt-ID monatlich', p.apple[plan].monthly)}
              {input(`apple.${plan}.yearly`, 'Produkt-ID jährlich', p.apple[plan].yearly)}
            </fieldset>
          ))}
        </div>
        <button className="btn" type="submit">
          Speichern
        </button>
      </form>
    </AdminShell>
  );
}
