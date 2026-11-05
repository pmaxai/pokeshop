import { notFound, redirect } from 'next/navigation';
import { formatEuro } from '@pokeshop/core';
import { handlePaymentEvent } from '@pokeshop/core/orders';
import { fakeProvider } from '@pokeshop/core/payments';
import { db } from '@/server/config';
import { payments } from '@/server/payments';

export const dynamic = 'force-dynamic';

type Fake = ReturnType<typeof fakeProvider>;

function fake(): Fake {
  const p = payments();
  if (!p || p.name !== 'fake') notFound();
  return p as Fake;
}

async function pay(form: FormData) {
  'use server';
  const p = fake();
  const id = String(form.get('id'));
  const s = p.sessions.get(id);
  if (!s) notFound();
  await handlePaymentEvent(db(), p, p.pay(id, String(form.get('method') ?? 'card')));
  redirect(s.input.successUrl.replace('{CHECKOUT_SESSION_ID}', id));
}

async function cancel(form: FormData) {
  'use server';
  const s = fake().sessions.get(String(form.get('id')));
  if (!s) notFound();
  redirect(s.input.cancelUrl);
}

/** Local stand-in for the Stripe payment page (only without Stripe keys on localhost). */
export default async function FakePayment({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = fake().sessions.get(id);
  if (!s) notFound();
  return (
    <div className="prose">
      <p className="notice notice--warn">Testzahlung – nur lokal, es fließt kein Geld.</p>
      <h1>{formatEuro(s.amountTotal ?? 0, 'de')}</h1>
      <p>
        Bestellung {s.input.orderNumber} · {s.input.email} · Status: {s.status}
      </p>
      <ul>
        {s.input.lines.map((l, i) => (
          <li key={i}>
            {l.quantity} × {l.name} – {formatEuro(l.unitAmount, 'de')}
          </li>
        ))}
      </ul>
      <form action={pay} className="actions">
        <input type="hidden" name="id" value={id} />
        <select name="method" defaultValue="card" aria-label="Zahlungsart">
          <option value="card">Karte</option>
          <option value="eps">EPS</option>
          <option value="paypal">PayPal</option>
        </select>{' '}
        <button className="btn btn--accent" type="submit" disabled={s.status !== 'open'}>
          Bezahlen
        </button>
      </form>
      <form action={cancel} style={{ marginTop: '1rem' }}>
        <input type="hidden" name="id" value={id} />
        <button className="btn btn--quiet" type="submit">
          Zurück zum Shop
        </button>
      </form>
    </div>
  );
}
