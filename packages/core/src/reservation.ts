/**
 * Reservation timing. Cards are held from the moment the buyer starts the
 * Stripe payment, for `minutes` (default 10). Stripe sessions live at least
 * 30 minutes, so the shop closes them itself once the hold has run out.
 */

export const DEFAULT_RESERVATION_MINUTES = 10;
/** Stripe's shortest allowed Checkout Session lifetime. */
export const STRIPE_MIN_SESSION_MINUTES = 30;

export function reservedUntil(now: Date, minutes = DEFAULT_RESERVATION_MINUTES): Date {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    throw new RangeError('reservation minutes must be an integer between 1 and 60');
  }
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * Expiry passed to Stripe: the shortest Stripe accepts, plus a small margin
 * so the request is not rejected for being a few seconds too short.
 */
export function stripeSessionExpiresAt(now: Date): number {
  return Math.floor(now.getTime() / 1000) + STRIPE_MIN_SESSION_MINUTES * 60 + 60;
}

export type HoldState =
  | 'active' // still within the hold
  | 'expired_unpaid' // close the Stripe session and release
  | 'pending_payment'; // async method pending: keep until Stripe reports

/**
 * What the sweeper does with an open order at `now`.
 * A payment that is already pending (e.g. a bank redirect awaiting
 * confirmation) keeps its hold until Stripe reports success or failure.
 */
export function holdState(input: {
  reservedUntil: Date;
  now: Date;
  paymentPending: boolean;
}): HoldState {
  if (input.now.getTime() < input.reservedUntil.getTime()) return 'active';
  return input.paymentPending ? 'pending_payment' : 'expired_unpaid';
}
