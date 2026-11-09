import { NextResponse, type NextRequest } from 'next/server';
import { orderByToken, releaseOrder, syncSession } from '@pokeshop/core/orders';
import { getPathname } from '@/i18n/navigation';
import { config, db } from '@/server/config';
import { paymentsForOrder } from '@/server/payments';

export const dynamic = 'force-dynamic';

/** Stripe's "back" link: close the payment and give the cards back right away. */
export async function GET(req: NextRequest) {
  const locale = req.nextUrl.searchParams.get('l') === 'en' ? 'en' : 'de';
  const token = req.nextUrl.searchParams.get('o') ?? '';
  const order = await orderByToken(db(), token);
  // Card orders are paid to the shop's account, licences to the GmbH's.
  const provider = order ? await paymentsForOrder(order.id) : null;
  if (order && order.status === 'checkout') {
    const [row] = await db()<{ stripe_session_id: string | null }[]>`
      SELECT stripe_session_id FROM orders WHERE id = ${order.id}`;
    const session = row?.stripe_session_id;
    const closed =
      session && provider ? await provider.expireSession(session).catch(() => null) : 'expired';
    if (closed === 'complete' && session && provider) {
      await syncSession(db(), provider, session);
      return NextResponse.redirect(
        `${config.baseUrl}${getPathname({ href: { pathname: '/bestellung/[token]', params: { token } }, locale })}`,
        303,
      );
    }
    if (closed === 'expired')
      await releaseOrder(db(), { id: order.id }, 'cancelled', 'buyer_cancelled');
  }
  // A licence purchase goes back to the app page, card orders to the cart.
  if (req.nextUrl.searchParams.get('app') === '1') {
    return NextResponse.redirect(
      `${config.baseUrl}${getPathname({ href: '/app', locale })}?cancelled=1#kaufen`,
      303,
    );
  }
  return NextResponse.redirect(
    `${config.baseUrl}${getPathname({ href: '/warenkorb', locale })}?cancelled=1`,
    303,
  );
}
