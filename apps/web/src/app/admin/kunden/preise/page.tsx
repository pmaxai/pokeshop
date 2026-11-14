import { subscriptionPrices } from '@pokeshop/core/subscriptions';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../../AdminShell';
import { savePricesAction } from '../../customer-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Abo-Preise' };

const euro = (c: number | null) => (c === null ? '' : (c / 100).toFixed(2).replace('.', ','));

export default async function Prices({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireAdmin('owner');
  const sp = await searchParams;
  const p = await subscriptionPrices(db());
  const field = (name: keyof typeof p, label: string, hint?: string) => (
    <label className="field">
      <span>{label}</span>
      <input name={name} inputMode="decimal" defaultValue={euro(p[name])} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
  return (
    <AdminShell user={user} active="customers" notice={sp}>
      <p>
        <a href="/admin/kunden">← Kunden & Abos</a>
      </p>
      <h1>Abo-Preise</h1>
      <p>
        Monatspreise in Euro inklusive USt. (österreichischer Satz; Kunden in anderen EU-Ländern
        zahlen denselben Bruttopreis, Stripe Tax rechnet die USt. ihres Landes heraus).
        EU-Unternehmen mit UID zahlen den Preis ohne österreichische USt. (Reverse Charge). Neue
        Preise gelten für neue Abos und für Änderungen; laufende Abos behalten ihren Preis.
      </p>
      <form action={savePricesAction} className="form-grid">
        {field('collector', 'Collector')}
        {field('creator', 'Creator')}
        {field('collector_device', 'Zusätzliches Gerät (Collector)')}
        {field('creator_device', 'Zusätzliches Gerät (Creator)')}
        {field('s3_gb', 'S3-Speicher pro GB hochgeladen', 'Leer, bis der Dienst angeboten wird.')}
        {field(
          'pipeline_minute',
          'Video-Pipeline pro Videominute',
          'Leer, bis der Dienst angeboten wird.',
        )}
        <div className="inline-form">
          <button className="btn" type="submit">
            Speichern
          </button>
        </div>
      </form>
    </AdminShell>
  );
}
