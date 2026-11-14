import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { accountOrders } from '@pokeshop/core/accounts';
import { accountEntitlements } from '@pokeshop/core/subscriptions';
import { getPathname, Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { requireAccount } from '@/server/account';
import { AccountShell } from '@/components/account/AccountShell';
import { OrderList } from '@/components/account/OrderList';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Account' });
  return { title: t('overview.title'), robots: { index: false } };
}

export default async function AccountPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const account = await requireAccount(locale, getPathname({ href: '/konto', locale }));
  const t = await getTranslations('Account');
  const [orders, ent] = await Promise.all([
    accountOrders(db(), account.id, 3),
    accountEntitlements(db(), account),
  ]);
  const tSub = await getTranslations('Subscription');
  const day = (d: Date) =>
    new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
      dateStyle: 'long',
      timeZone: 'Europe/Vienna',
    }).format(d);
  const a = account.shippingAddress;
  const names = new Intl.DisplayNames([locale === 'de' ? 'de-AT' : 'en'], { type: 'region' });
  return (
    <AccountShell account={account} active="overview" title={t('overview.title')} locale={locale}>
      {ent.active && ent.plan ? (
        <section className="account-panel account-panel--app" aria-labelledby="ov-app">
          <div className="account-panel__head">
            <h2 id="ov-app">{t('overview.subTitle', { plan: tSub(`plans.${ent.plan}.name`) })}</h2>
            <span className={`sub-state sub-state--${ent.state}`}>
              {tSub(`state.${ent.state}`)}
            </span>
          </div>
          <p>
            {ent.state === 'complimentary' && !ent.endsAt
              ? t('overview.subFree')
              : ent.endsAt
                ? t('overview.subEnds', { date: day(ent.endsAt) })
                : ent.renewsAt
                  ? t('overview.subRenews', { date: day(ent.renewsAt) })
                  : null}{' '}
            {tSub('devicesValue', { total: ent.seats, extra: ent.extraDevices })}
          </p>
          <p className="account-panel__actions">
            <Link href="/konto/geraete" className="btn btn--accent">
              {t('overview.subDevices')}
            </Link>
            <Link href="/konto/abo">{t('overview.subManage')}</Link>
          </p>
        </section>
      ) : (
        <section className="account-panel account-panel--app" aria-labelledby="ov-app">
          <h2 id="ov-app">{t('overview.appTitle')}</h2>
          <p>{t('overview.appText')}</p>
          <p>
            <Link href="/konto/abo" className="btn btn--accent">
              {t('overview.appLink')}
            </Link>
          </p>
        </section>
      )}
      <section className="account-panel" aria-labelledby="ov-orders">
        <div className="account-panel__head">
          <h2 id="ov-orders">{t('overview.ordersTitle')}</h2>
          {orders.length > 0 && <Link href="/konto/bestellungen">{t('overview.allOrders')}</Link>}
        </div>
        {orders.length === 0 ? (
          <p className="muted">{t('orders.empty')}</p>
        ) : (
          <OrderList orders={orders} locale={locale} />
        )}
      </section>
      <section className="account-panel" aria-labelledby="ov-address">
        <div className="account-panel__head">
          <h2 id="ov-address">{t('overview.addressTitle')}</h2>
          <Link href="/konto/adresse">
            {a ? t('overview.addressChange') : t('overview.addressAdd')}
          </Link>
        </div>
        {a ? (
          <address className="account-address">
            {a.name}
            {a.company && (
              <>
                <br />
                {a.company}
              </>
            )}
            <br />
            {a.street}
            <br />
            {a.postcode} {a.city}
            <br />
            {names.of(a.country) ?? a.country}
          </address>
        ) : (
          <p className="muted">{t('overview.noAddress')}</p>
        )}
      </section>
    </AccountShell>
  );
}
