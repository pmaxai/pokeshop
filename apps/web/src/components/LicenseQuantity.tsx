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
  const [value, setValue] = useState(String(initial));
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= max;
  return (
    <>
      <label className={error ? 'field field--error' : 'field'} htmlFor="app-quantity">
        <span>{t('quantity')}</span>
        <input
          id="app-quantity"
          name="quantity"
          type="number"
          inputMode="numeric"
          min={1}
          max={max}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby="app-quantity-hint"
          aria-invalid={error ? true : undefined}
        />
        <small id="app-quantity-hint" className={error ? 'field__error' : 'muted'}>
          {error ?? t('quantityHint', { max, price: formatEuro(priceCents, locale) })}
        </small>
      </label>
      <dl className="totals">
        <dt className="totals__total">{t('total')}</dt>
        <dd className="totals__total" aria-live="polite">
          {valid ? formatEuro(priceCents * n, locale) : '–'}
        </dd>
      </dl>
    </>
  );
}
