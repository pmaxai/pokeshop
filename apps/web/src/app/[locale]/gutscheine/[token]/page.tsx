import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core/money';
import { syncSession } from '@pokeshop/core/orders';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { payments } from '@/server/payments';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale; token: string }>;
  searchParams: Promise<{ session_id?: string }>;
};

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

type Row = {
  id: number;
  number: string;
  status: string;
  email: string | null;
  value_cents: number;
  code: string | null;
};

const load = async (token: string) =>
  /^[A-Za-z0-9_-]{20,64}$/.test(token)
    ? (
        await db()<Row[]>`
        SELECT o.id, o.number, o.status, o.email, g.value_cents, v.code
          FROM orders o JOIN order_gift_vouchers g ON g.order_id = o.id
          LEFT JOIN vouchers v ON v.id = g.voucher_id
         WHERE o.lookup_token = ${token} AND o.kind = 'voucher'`
      )[0]
    : undefined;

/** Back from Stripe: the voucher with its code and PDF, or where the payment stands. */
export default async function VoucherOrderPage({ params, searchParams }: Props) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  let order = await load(token);
  if (!order) notFound();
  const sessionId = (await searchParams).session_id;
  const provider = payments('shop');
  if (order.status === 'checkout' && sessionId && provider) {
    const [own] =
      await db()`SELECT 1 FROM orders WHERE id = ${order.id} AND stripe_session_id = ${sessionId}`;
    if (own) {
      await syncSession(db(), provider, sessionId).catch((e) =>
        console.error('[voucher order] sync', (e as Error).message),
      );
      order = (await load(token))!;
    }
  }
  const t = await getTranslations('Vouchers.thanks');
  const value = formatEuro(order.value_cents, locale);

  if (order.code && ['completed', 'paid'].includes(order.status)) {
    return (
      <div className="wrap order-page gv-thanks">
        <h1>{t('title')}</h1>
        <p className="lead">{t('text', { value, email: order.email ?? '' })}</p>
        <p className="gv-thanks__code">
          <small>{t('code')}</small>
          <strong>{order.code}</strong>
        </p>
        <p className="actions">
          <a className="btn btn--accent" href={`/api/voucher/${token}?l=${locale}`} download>
            {t('download')}
          </a>
          <Link href="/karten" className="btn btn--quiet">
            {t('shop')}
          </Link>
        </p>
        <p className="muted small">{t('facts', { number: order.number })}</p>
      </div>
    );
  }
  if (order.status === 'refunded') {
    return (
      <div className="wrap order-page gv-thanks">
        <h1>{t('refundedTitle')}</h1>
        <p className="lead">{t('refundedText')}</p>
      </div>
    );
  }
  if (['checkout', 'awaiting_payment'].includes(order.status)) {
    return (
      <div className="wrap order-page gv-thanks">
        <h1>{t('pendingTitle')}</h1>
        <p className="lead">{t('pendingText')}</p>
        <p className="actions">
          <Link href={{ pathname: '/gutscheine/[token]', params: { token } }} className="btn">
            {t('reload')}
          </Link>
        </p>
      </div>
    );
  }
  return (
    <div className="wrap order-page gv-thanks">
      <h1>{t('failedTitle')}</h1>
      <p className="lead">{t('failedText')}</p>
      <p className="actions">
        <Link href="/gutscheine" className="btn btn--accent">
          {t('again')}
        </Link>
      </p>
    </div>
  );
}
