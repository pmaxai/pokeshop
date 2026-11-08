'use client';

import { useActionState, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatEuro } from '@pokeshop/core';
import { Link } from '@/i18n/navigation';
import { quickAddAction, type QuickAddState } from '@/app/[locale]/shop-actions';

export type QuickAddVariant = {
  id: number;
  condition: string;
  /** "Near Mint" – for the tooltip and screen readers. */
  conditionName: string;
  priceCents: number;
  available: number;
  inCart: number;
};

/**
 * Price, stock and add-to-cart at the foot of a catalog tile. A card in several conditions
 * gets a condition picker; price and stock follow the choice. One copy per click, the page
 * stays where it is; the line under the button says how many are in the cart and links there.
 *
 * The picker sits outside the form: React resets a form after its action, which would snap
 * the radios back to the server-rendered choice while the state keeps the visitor's.
 */
export function QuickAdd({
  variants,
  leadId,
  locale,
  cardLabel,
}: {
  variants: QuickAddVariant[];
  leadId: number;
  locale: 'de' | 'en';
  /** Name of the card, for the picker's accessible name. */
  cardLabel: string;
}) {
  const t = useTranslations('Card');
  const group = useId();
  const [selectedId, setSelectedId] = useState(leadId);
  const [state, action, pending] = useActionState<QuickAddState, FormData>(quickAddAction, {
    status: 'idle',
    quantity: 0,
  });
  const v = variants.find((x) => x.id === selectedId) ?? variants[0]!;
  const fresh = state.status !== 'idle' && state.productId === v.id;
  const quantity = fresh ? state.quantity : v.inCart;
  const soldOut = v.available === 0 || (fresh && state.status === 'unavailable' && quantity === 0);
  const allInCart = !soldOut && quantity >= v.available;
  const many = variants.length > 1;

  return (
    <div className="tile__buy">
      {many && (
        <fieldset className="cond-pick">
          <legend className="visually-hidden">{t('chooseCondition', { card: cardLabel })}</legend>
          {variants.map((x) => (
            <label key={x.id} className="cond-pick__opt" title={x.conditionName}>
              <input
                type="radio"
                name={group}
                value={x.id}
                checked={x.id === v.id}
                disabled={x.available === 0}
                onChange={() => setSelectedId(x.id)}
              />
              <span aria-hidden="true">{x.condition}</span>
              <span className="visually-hidden">
                {x.conditionName}, {formatEuro(x.priceCents, locale)}
                {x.available === 0 ? `, ${t('soldOut')}` : ''}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="tile__foot">
        <span className="price">{formatEuro(v.priceCents, locale)}</span>
        {v.available > 0 ? (
          <span className={v.available === 1 ? 'stock stock--last' : 'stock'}>
            {t('available', { count: v.available })}
          </span>
        ) : (
          <span className="stock muted">{t('soldOut')}</span>
        )}
      </div>
      <form action={action} className="tile__add">
        <input type="hidden" name="product_id" value={v.id} />
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
    </div>
  );
}
