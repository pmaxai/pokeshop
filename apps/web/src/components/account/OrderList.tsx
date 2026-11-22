import { getTranslations } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import type { AccountOrder } from '@pokeshop/core/accounts';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';

const STATUSES = [
  'awaiting_payment',
  'paid',
  'packing',
  'shipped',
  'completed',
  'cancelled',
  'refunded',
] as const;

export async function OrderList({ orders, locale }: { orders: AccountOrder[]; locale: Locale }) {
  const t = await getTranslations('Account');
  const date = new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
    dateStyle: 'medium',
    timeZone: 'Europe/Vienna',
  });
  return (
    <ul className="order-list">
      {orders.map((o) => {
        const status = STATUSES.find((s) => s === o.status);
        return (
          <li key={o.number}>
            <Link
              href={{ pathname: '/bestellung/[token]', params: { token: o.token } }}
              className="order-list__link"
            >
              <span className="order-list__number num">{o.number}</span>
              <span className="order-list__what">
                {o.kind === 'cards' ? t('orders.cards', { count: o.items }) : t('orders.voucher')}
              </span>
              <span className="order-list__date muted">{date.format(o.createdAt)}</span>
              <span className={`order-list__status order-list__status--${o.status}`}>
                {status ? t(`orderStatus.${status}`) : o.status}
              </span>
              <span className="order-list__total num">{formatEuro(o.totalCents, locale)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
