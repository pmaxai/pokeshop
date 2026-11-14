import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { accountOrders } from '@pokeshop/core/accounts';
import { getPathname } from '@/i18n/navigation';
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
  return { title: t('orders.title'), robots: { index: false } };
}

export default async function AccountOrdersPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const account = await requireAccount(
    locale,
    getPathname({ href: '/konto/bestellungen', locale }),
  );
  const t = await getTranslations('Account');
  const orders = await accountOrders(db(), account.id);
  return (
    <AccountShell account={account} active="orders" title={t('orders.title')} locale={locale}>
      <p className="muted">{t('orders.intro')}</p>
      {orders.length === 0 ? (
        <p className="account-empty">{t('orders.empty')}</p>
      ) : (
        <OrderList orders={orders} locale={locale} />
      )}
    </AccountShell>
  );
}
