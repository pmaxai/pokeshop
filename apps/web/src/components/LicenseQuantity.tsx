'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatEuro } from '@pokeshop/core';

/** Number of licences with the running total (the Stripe page shows the same amount). */
export function LicenseQuantity({
  priceCents,
  locale,
  max,
  initial,
  error,
}: {
  priceCents: number;
  locale: 'de' | 'en';
  max: number;
  initial: number;
  error: string | null;
}) {
  const t = useTranslations('App.form');
  const [n, setN] = useState(initial);
  const price = formatEuro(priceCents, locale);
  return (
    <>
      <label className={error ? 'field field--error' : 'field'} htmlFor="app-quantity">
        <span>{t('quantity')}</span>
        <select
          id="app-quantity"
          name="quantity"
          value={String(n)}
          onChange={(e) => setN(Number(e.target.value))}
          aria-describedby="app-quantity-hint"
        >
          {Array.from({ length: max }, (_, i) => i + 1).map((k) => (
            <option key={k} value={k}>
              {t('each', { count: k, price })}
            </option>
          ))}
        </select>
        <small id="app-quantity-hint" className={error ? 'field__error' : 'muted'}>
          {error ?? t('quantityHint', { max })}
        </small>
      </label>
      <dl className="totals">
        <dt className="totals__total">{t('total')}</dt>
        <dd className="totals__total" aria-live="polite">
          {formatEuro(priceCents * n, locale)}
        </dd>
      </dl>
    </>
  );
}
