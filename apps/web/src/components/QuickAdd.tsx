'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { quickAddAction, type QuickAddState } from '@/app/[locale]/shop-actions';

/**
 * Add-to-cart on a catalog tile. One copy per click, the page stays where it is; the line
 * under the button says how many are in the cart and links there.
 */
export function QuickAdd({
  productId,
  locale,
  available,
  inCart,
}: {
  productId: number;
  locale: 'de' | 'en';
  available: number;
  inCart: number;
}) {
  const t = useTranslations('Card');
  const [state, action, pending] = useActionState<QuickAddState, FormData>(quickAddAction, {
    status: 'idle',
    quantity: inCart,
  });
  const quantity = state.status === 'idle' ? inCart : state.quantity;
  const soldOut = state.status === 'unavailable' && quantity === 0;
  const allInCart = !soldOut && quantity >= available;
  return (
    <form action={action} className="tile__add">
      <input type="hidden" name="product_id" value={productId} />
      <input type="hidden" name="locale" value={locale} />
      {soldOut ? (
        <span className="btn btn--small" aria-disabled="true">
          {t('soldOutNow')}
        </span>
      ) : allInCart ? (
        <Link href="/warenkorb" className="btn btn--small btn--quiet">
          {t('allInCart')}
        </Link>
      ) : (
        <button
          type="submit"
          className="btn btn--small btn--accent"
          disabled={pending}
          aria-busy={pending}
        >
          {pending ? t('adding') : t('addToCart')}
        </button>
      )}
      <span className="tile__in-cart" role="status">
        {quantity > 0 && !allInCart && (
          <Link href="/warenkorb">{t('inCartCount', { count: quantity })}</Link>
        )}
      </span>
    </form>
  );
}
