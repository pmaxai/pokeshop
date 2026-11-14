import { notFound, redirect } from 'next/navigation';
import { formatEuro } from '@pokeshop/core';
import type { FakeBilling } from '@pokeshop/core/billing';
import { handleBillingEvent } from '@pokeshop/core/subscriptions';
import { db } from '@/server/config';
import { billing } from '@/server/billing';

export const dynamic = 'force-dynamic';

function fake(): FakeBilling {
  const b = billing();
  if (b?.name !== 'fake') notFound();
  return b as FakeBilling;
}

async function pay(form: FormData) {
  'use server';
  const b = fake();
  const id = String(form.get('id'));
  const s = b.store.sessions.get(id);
  if (!s) notFound();
  const paid = b.pay(id);
  // what Stripe's webhooks would deliver
  await handleBillingEvent(db(), b, {
    type: 'checkout_completed',
    subscriptionId: paid.subscriptionId,
  });
  await handleBillingEvent(db(), b, {
    type: 'invoice_paid',
    invoiceId: paid.invoiceId,
    subscriptionId: paid.subscriptionId,
    reason: 'subscription_create',
  });
  redirect(s.input.successUrl.replace('{CHECKOUT_SESSION_ID}', id));
}

async function cancel(form: FormData) {
  'use server';
  const s = fake().store.sessions.get(String(form.get('id')));
  if (!s) notFound();
  redirect(s.input.cancelUrl);
}

/** Local stand-in for Stripe Checkout in subscription mode (no Stripe keys, localhost only). */
export default async function FakeSubscriptionCheckout({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const s = fake().store.sessions.get(id);
  if (!s) notFound();
  const i = s.input;
  const total = i.baseCents + i.extraDevices * i.deviceCents;
  return (
    <div className="prose">
      <p className="notice notice--warn">Test-Abo – nur lokal, es fließt kein Geld.</p>
      <h1>{formatEuro(total, 'de')} / Monat</h1>
      <p>
        {i.plan === 'creator' ? 'Creator' : 'Collector'} · {1 + i.extraDevices} Gerät(e) · Preise{' '}
        {i.behavior === 'incl' ? 'brutto' : 'netto (Reverse Charge)'} · Konto {i.publicId}
      </p>
      <form action={pay}>
        <input type="hidden" name="id" value={id} />
        <button className="btn btn--accent" type="submit" disabled={s.status !== 'open'}>
          Abonnieren
        </button>
      </form>
      <form action={cancel} style={{ marginTop: '1rem' }}>
        <input type="hidden" name="id" value={id} />
        <button className="btn btn--quiet" type="submit">
          Zurück
        </button>
      </form>
    </div>
  );
}
