import { notFound } from 'next/navigation';
import { billing } from '@/server/billing';

export const dynamic = 'force-dynamic';

/** Stand-in for Stripe's customer portal (payment method, invoices). */
export default async function FakePortal({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; return?: string }>;
}) {
  if (billing()?.name !== 'fake') notFound();
  const q = await searchParams;
  const back = q.return?.startsWith('http://localhost') ? q.return : '/';
  return (
    <div className="prose">
      <p className="notice notice--warn">Stripe-Kundenportal (lokaler Ersatz).</p>
      <h1>Zahlungsart und Rechnungen</h1>
      <p>Kunde {q.customer}. Bei Stripe ändert man hier Karte, Adresse und lädt Rechnungen.</p>
      <p>
        <a className="btn" href={back}>
          Zurück zum Konto
        </a>
      </p>
    </div>
  );
}
