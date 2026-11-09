import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import { appSales, downloadPath, licenseOrderByToken } from '@pokeshop/core/licenses';
import { syncSession } from '@pokeshop/core/orders';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db, licenseServiceConfigured } from '@/server/config';
import { paymentsForOrder } from '@/server/payments';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale; token: string }>;
  searchParams: Promise<{ session_id?: string }>;
};

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/** Where Stripe sends the buyer back to: payment state, and the download once paid. */
export default async function LicenceOrderPage({ params, searchParams }: Props) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  let order = await licenseOrderByToken(db(), token);
  if (!order) notFound();

  // Back from Stripe before the webhook: ask Stripe directly instead of waiting.
  const sessionId = (await searchParams).session_id;
  const provider =
    order.status === 'checkout' && sessionId ? await paymentsForOrder(order.id) : null;
  if (order.status === 'checkout' && sessionId && provider) {
    const [own] =
      await db()`SELECT 1 FROM orders WHERE id = ${order.id} AND stripe_session_id = ${sessionId}`;
    if (own) {
      await syncSession(db(), provider, sessionId).catch((e) =>
        console.error('[licence order] sync', (e as Error).message),
      );
      order = (await licenseOrderByToken(db(), token))!;
    }
  }

  const t = await getTranslations('App.thanks');
  const sales = await appSales(db(), licenseServiceConfigured());
  const facts = t('facts', {
    number: order.number,
    count: order.quantity,
    total: formatEuro(order.totalCents, locale),
  });
  const mb = (b: number) =>
    `${new Intl.NumberFormat(locale === 'de' ? 'de-AT' : 'en-GB', { maximumFractionDigits: 0 }).format(b / 1_000_000)} MB`;

  if (order.status === 'refunded') {
    return (
      <div className="wrap order-page app-thanks">
        <h1>{t('refundedTitle')}</h1>
        <p className="lead">{t('refundedText')}</p>
        <p className="muted">{facts}</p>
        <p className="actions">
          <Link href="/app">{t('back')}</Link>
        </p>
      </div>
    );
  }
  if (!['paid', 'completed'].includes(order.status)) {
    const pending = order.status === 'checkout' || order.status === 'awaiting_payment';
    return (
      <div className="wrap order-page app-thanks">
        <h1>{pending ? t('pendingTitle') : t('unpaidTitle')}</h1>
        <p className="lead">{pending ? t('pendingText') : t('unpaidText')}</p>
        <p className="muted">{facts}</p>
        <p className="actions">
          {pending ? (
            <a className="btn" href="">
              {t('reload')}
            </a>
          ) : (
            <Link className="btn btn--accent" href="/app">
              {t('back')}
            </Link>
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="wrap order-page app-thanks">
      <h1>{t('title')}</h1>
      <p className="lead">{t('text', { email: order.email ?? '' })}</p>
      <p className="muted">{facts}</p>
      {order.canDownload && (
        <div className="app-download">
          {sales.playStoreUrl ? (
            <a className="btn btn--accent" href={sales.playStoreUrl} rel="noopener noreferrer">
              {t('store')}
            </a>
          ) : (
            sales.release && (
              <>
                <a className="btn btn--accent" href={downloadPath(token)} download>
                  {t('download')}
                </a>
                <span className="muted small">
                  {t('downloadMeta', {
                    version: sales.release.version,
                    size: mb(sales.release.sizeBytes),
                  })}
                </span>
              </>
            )
          )}
          <p className="small">{t('installHint')}</p>
        </div>
      )}
      <p className="actions">
        <Link href="/app">{t('back')}</Link>
      </p>
    </div>
  );
}
