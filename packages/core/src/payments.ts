// Payment provider: Stripe Checkout in production, a local stand-in for development and tests.
// The shop only talks to this interface, so order logic is tested without the network.
import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';

export type SessionInput = {
  orderId: number;
  orderNumber: string;
  email: string;
  locale: 'de' | 'en';
  lines: { name: string; description?: string; unitAmount: number; quantity: number }[];
  successUrl: string;
  cancelUrl: string;
  /** Unix seconds; Stripe needs at least 30 minutes, the shop expires the session itself. */
  expiresAt: number;
};

export type SessionInfo = {
  id: string;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  paymentIntentId: string | null;
  paymentMethodType: string | null;
  amountTotal: number | null;
  orderId: number | null;
};

/** Stripe events reduced to what the shop acts on. */
export type PaymentEvent =
  | {
      id: string;
      type:
        | 'checkout.session.completed'
        | 'checkout.session.async_payment_succeeded'
        | 'checkout.session.async_payment_failed'
        | 'checkout.session.expired';
      sessionId: string;
    }
  | { id: string; type: 'charge.refunded'; paymentIntentId: string; amountRefunded: number }
  | { id: string; type: 'charge.dispute.created'; paymentIntentId: string; amount: number }
  | { id: string; type: 'other'; stripeType: string };

export interface PaymentProvider {
  readonly name: 'stripe' | 'fake';
  createSession(input: SessionInput): Promise<{ id: string; url: string }>;
  getSession(id: string): Promise<SessionInfo>;
  /** Closes an open session. 'complete' means it was paid before it could be closed. */
  expireSession(id: string): Promise<'expired' | 'complete'>;
  refund(input: {
    paymentIntentId: string;
    amount: number;
    idempotencyKey: string;
  }): Promise<{ id: string; status: string }>;
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

export type StripeOptions = {
  secretKey: string;
  webhookSecret?: string;
  /** Allowed payment methods; card covers Apple Pay and Google Pay. */
  paymentMethods?: string[];
  client?: Stripe;
};

export const DEFAULT_PAYMENT_METHODS = ['card', 'eps', 'paypal'];

function toSessionInfo(s: Stripe.Checkout.Session): SessionInfo {
  const pi = s.payment_intent;
  const piId = typeof pi === 'string' ? pi : (pi?.id ?? null);
  let method: string | null = null;
  if (pi && typeof pi !== 'string') {
    const pm = pi.payment_method;
    method = pm && typeof pm !== 'string' ? pm.type : null;
  }
  const orderId = Number(s.metadata?.order_id ?? NaN);
  return {
    id: s.id,
    status: (s.status ?? 'open') as SessionInfo['status'],
    paymentStatus: s.payment_status as SessionInfo['paymentStatus'],
    paymentIntentId: piId,
    paymentMethodType: method,
    amountTotal: s.amount_total ?? null,
    orderId: Number.isSafeInteger(orderId) ? orderId : null,
  };
}

export function stripeProvider(opts: StripeOptions): PaymentProvider & {
  parseWebhook(raw: string, signature: string): PaymentEvent;
} {
  const stripe =
    opts.client ?? new Stripe(opts.secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
  const methods = opts.paymentMethods?.length ? opts.paymentMethods : DEFAULT_PAYMENT_METHODS;
  return {
    name: 'stripe',
    async createSession(input) {
      const s = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          locale: input.locale,
          customer_email: input.email,
          client_reference_id: input.orderNumber,
          allowed_payment_method_types: methods,
          line_items: input.lines.map((l) => ({
            quantity: l.quantity,
            price_data: {
              currency: 'eur',
              unit_amount: l.unitAmount,
              product_data: {
                name: l.name,
                ...(l.description ? { description: l.description } : {}),
              },
            },
          })),
          metadata: { order_id: String(input.orderId), order_number: input.orderNumber },
          payment_intent_data: {
            description: input.orderNumber,
            metadata: { order_id: String(input.orderId), order_number: input.orderNumber },
          },
          expires_at: input.expiresAt,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
        },
        { idempotencyKey: `order-${input.orderId}-session` },
      );
      if (!s.url) throw new Error('Stripe returned a session without URL');
      return { id: s.id, url: s.url };
    },
    async getSession(id) {
      return toSessionInfo(
        await stripe.checkout.sessions.retrieve(id, { expand: ['payment_intent.payment_method'] }),
      );
    },
    async expireSession(id) {
      try {
        await stripe.checkout.sessions.expire(id);
        return 'expired';
      } catch (e) {
        // Only open sessions can be expired: find out what happened instead.
        const s = await stripe.checkout.sessions.retrieve(id);
        if (s.status === 'complete') return 'complete';
        if (s.status === 'expired') return 'expired';
        throw e;
      }
    },
    async refund(input) {
      const r = await stripe.refunds.create(
        { payment_intent: input.paymentIntentId, amount: input.amount },
        { idempotencyKey: input.idempotencyKey },
      );
      return { id: r.id, status: r.status ?? 'pending' };
    },
    parseWebhook(raw, signature) {
      if (!opts.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
      const e = stripe.webhooks.constructEvent(raw, signature, opts.webhookSecret);
      return normaliseStripeEvent(e);
    },
  };
}

export function normaliseStripeEvent(e: Stripe.Event): PaymentEvent {
  switch (e.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      return { id: e.id, type: e.type, sessionId: e.data.object.id };
    case 'charge.refunded': {
      const c = e.data.object;
      const pi = typeof c.payment_intent === 'string' ? c.payment_intent : c.payment_intent?.id;
      return {
        id: e.id,
        type: 'charge.refunded',
        paymentIntentId: pi ?? '',
        amountRefunded: c.amount_refunded,
      };
    }
    case 'charge.dispute.created': {
      const d = e.data.object;
      const pi = typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent?.id;
      return {
        id: e.id,
        type: 'charge.dispute.created',
        paymentIntentId: pi ?? '',
        amount: d.amount,
      };
    }
    default:
      return { id: e.id, type: 'other', stripeType: e.type };
  }
}

// ---------------------------------------------------------------------------
// Local stand-in: sessions live in memory; /dev/zahlung/<id> plays the Stripe page.
// ---------------------------------------------------------------------------

type FakeSession = SessionInfo & { input: SessionInput };

export function fakeProvider(baseUrl: string): PaymentProvider & {
  sessions: Map<string, FakeSession>;
  /** What the Stripe page does when the buyer pays: returns the webhook event to process. */
  pay(id: string, method?: string): PaymentEvent;
  refunds: { paymentIntentId: string; amount: number; idempotencyKey: string }[];
} {
  const sessions = new Map<string, FakeSession>();
  const refunds: { paymentIntentId: string; amount: number; idempotencyKey: string }[] = [];
  const g = globalThis as unknown as { __pokeshopFakeSessions?: Map<string, FakeSession> };
  const store = (g.__pokeshopFakeSessions ??= sessions);
  return {
    name: 'fake',
    sessions: store,
    refunds,
    async createSession(input) {
      const id = `cs_fake_${randomBytes(12).toString('hex')}`;
      store.set(id, {
        id,
        status: 'open',
        paymentStatus: 'unpaid',
        paymentIntentId: null,
        paymentMethodType: null,
        amountTotal: input.lines.reduce((a, l) => a + l.unitAmount * l.quantity, 0),
        orderId: input.orderId,
        input,
      });
      return { id, url: `${baseUrl}/dev/zahlung/${id}` };
    },
    async getSession(id) {
      const s = store.get(id);
      if (!s) throw new Error(`unknown session ${id}`);
      const { input: _input, ...info } = s;
      return info;
    },
    async expireSession(id) {
      const s = store.get(id);
      if (!s) return 'expired';
      if (s.status === 'complete') return 'complete';
      s.status = 'expired';
      return 'expired';
    },
    async refund(input) {
      refunds.push(input);
      return { id: `re_fake_${refunds.length}`, status: 'succeeded' };
    },
    pay(id, method = 'card') {
      const s = store.get(id);
      if (!s || s.status !== 'open') throw new Error('session is not open');
      s.status = 'complete';
      s.paymentStatus = 'paid';
      s.paymentIntentId = `pi_fake_${randomBytes(8).toString('hex')}`;
      s.paymentMethodType = method;
      return {
        id: `evt_fake_${randomBytes(8).toString('hex')}`,
        type: 'checkout.session.completed',
        sessionId: id,
      };
    },
  };
}

/**
 * Provider from the environment: Stripe when STRIPE_SECRET_KEY is set, otherwise the local
 * stand-in – but only while PUBLIC_BASE_URL points to localhost, so a real shop can never
 * take orders without Stripe.
 */
export function paymentsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const base = env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
  if (env.STRIPE_SECRET_KEY) {
    return stripeProvider({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      paymentMethods: env.STRIPE_PAYMENT_METHODS?.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) return fakeProvider(base);
  return null;
}
