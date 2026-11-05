import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro, formatRate } from '@pokeshop/core';
import { orderByToken, syncSession } from '@pokeshop/core/orders';
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

export default async function OrderPage({ params, searchParams }: Props) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  let order = await orderByToken(db(), token);
  if (!order) notFound();

  // Back from Stripe before the webhook: ask Stripe directly instead of waiting.
  const sessionId = (await searchParams).session_id;
  const provider = payments();
  if (order.status === 'checkout' && sessionId && provider) {
    const [own] =
      await db()`SELECT 1 FROM orders WHERE id = ${order.id} AND stripe_session_id = ${sessionId}`;
    if (own) {
      await syncSession(db(), provider, sessionId).catch((e) =>
        console.error('[order] sync', (e as Error).message),
      );
      order = (await orderByToken(db(), token))!;
    }
  }

  const t = await getTranslations('Order');
  const tCart = await getTranslations('Cart');
  const tl = await getTranslations('Languages');
  const dateFmt = new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
    dateStyle: 'long',
    timeZone: 'Europe/Vienna',
  });
  const timeFmt = new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
    timeStyle: 'short',
    timeZone: 'Europe/Vienna',
  });
  const paid = ['paid', 'packing', 'shipped', 'completed'].includes(order.status);
  const a = order.shippingAddress;

  let head: React.ReactNode;
  if (paid) {
    head = (
      <>
        <h1>{order.status === 'shipped' ? t('shipped') : t('thanks')}</h1>
        <p className="lead">{t('paidText', { email: order.email ?? '' })}</p>
      </>
    );
  } else if (order.status === 'checkout' || order.status === 'awaiting_payment') {
    head = (
      <>
        <h1>{t('pending')}</h1>
        <p className="lead">{t('pendingText')}</p>
        {order.reservedUntil && (
          <p>{t('heldUntil', { time: timeFmt.format(order.reservedUntil) })}</p>
        )}
        <p className="actions">
          <Link href={{ pathname: '/bestellung/[token]', params: { token } }} className="btn">
            {t('reload')}
          </Link>
          {order.paymentUrl && (
            <a href={order.paymentUrl} className="btn btn--accent">
              {t('continuePayment')}
            </a>
          )}
        </p>
      </>
    );
  } else if (order.status === 'refunded') {
    head = (
      <>
        <h1>{t('refunded')}</h1>
        <p className="lead">{t('refundedText')}</p>
      </>
    );
  } else {
    head = (
      <>
        <h1>{t('notPaid')}</h1>
        <p className="lead">{t('notPaidText')}</p>
        <p>
          <Link href="/warenkorb" className="btn btn--accent">
            {tCart('title')}
          </Link>
        </p>
      </>
    );
  }

  return (
    <div className="wrap order-page">
      <p className="muted">
        {t('title', { number: order.number })} ·{' '}
        {t('orderedOn', { date: dateFmt.format(order.createdAt) })}
      </p>
      {head}
      <section className="order-detail">
        <div>
          <h2>{t('items')}</h2>
          <ul className="summary__lines">
            {order.items.map((i) => (
              <li key={i.productId}>
                <span>
                  {i.quantity > 1 ? `${i.quantity} × ` : ''}
                  {locale === 'en' ? i.nameEn : i.nameDe}{' '}
                  <span className="num muted">{i.cardNumber}</span>
                  <br />
                  <small className="muted">
                    {(locale === 'en' ? i.setNameEn : i.setNameDe) ?? ''} ·{' '}
                    {tl(i.cardLanguage as never)} · {i.condition}
                  </small>
                </span>
                <span>{formatEuro(i.unitPriceCents * i.quantity, locale)}</span>
              </li>
            ))}
          </ul>
          <dl className="totals">
            <dt>{tCart('goods')}</dt>
            <dd>{formatEuro(order.goodsCents, locale)}</dd>
            <dt>
              {order.shippingMethod === 'insured'
                ? tCart('shippingInsured')
                : order.shippingMethod === 'tracked'
                  ? tCart('shippingTracked')
                  : tCart('shipping')}
            </dt>
            <dd>
              {order.shippingCents > 0
                ? formatEuro(order.shippingCents, locale)
                : tCart('shippingFree')}
            </dd>
            <dt className="totals__total">{tCart('total')}</dt>
            <dd className="totals__total">{formatEuro(order.totalCents, locale)}</dd>
          </dl>
          <p className="muted small">
            {tCart('vat', { rate: formatRate(order.vatRateBp, locale) })}:{' '}
            {formatEuro(order.vatCents, locale)}
          </p>
        </div>
        <div>
          <h2>{t('deliverTo')}</h2>
          <address>
            {a.company && (
              <>
                {a.company}
                <br />
              </>
            )}
            {a.name}
            <br />
            {a.street}
            <br />
            {a.postcode} {a.city}
            <br />
            {new Intl.DisplayNames([locale === 'de' ? 'de-AT' : 'en'], { type: 'region' }).of(
              a.country,
            )}
          </address>
          {paid && (
            <p>
              <Link href="/vertrag-widerrufen" className="withdraw-link">
                {t('withdraw')}
              </Link>
            </p>
          )}
          <p>
            <Link href="/karten">{t('backToShop')}</Link>
          </p>
        </div>
      </section>
    </div>
  );
}
