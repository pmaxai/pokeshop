import { Fragment } from 'react';
import { useTranslations } from 'next-intl';
import { formatEuro } from '@pokeshop/core/money';
type Reduction = { code: string; amount: number };
export type CodeLinesPricing = {
  code: { label: { de: string; en: string }; amount: number } | null;
  promo: Reduction[];
  paid: Reduction[];
  total: number;
  voucher: number;
  due: number;
};

/**
 * The lines of a totals list (dl) from the discounts on: discount code and promotional vouchers
 * above the total, bought vouchers below it as payment, then what is left to pay.
 */
export function CodeLines({ pricing, locale }: { pricing: CodeLinesPricing; locale: 'de' | 'en' }) {
  const t = useTranslations('Cart');
  const minus = (c: number) => `−${formatEuro(c, locale)}`;
  return (
    <>
      {pricing.code && (
        <>
          <dt className="totals__reduction">{pricing.code.label[locale]}</dt>
          <dd className="totals__reduction">{minus(pricing.code.amount)}</dd>
        </>
      )}
      {pricing.promo.map((v) => (
        <Fragment key={v.code}>
          <dt className="totals__reduction">
            {t.rich('codes.promoLine', {
              code: v.code,
              c: (x) => <span className="nowrap">{x}</span>,
            })}
          </dt>
          <dd className="totals__reduction">{minus(v.amount)}</dd>
        </Fragment>
      ))}
      <dt className="totals__total">{t('total')}</dt>
      <dd className="totals__total">{formatEuro(pricing.total, locale)}</dd>
      {pricing.paid.map((v) => (
        <Fragment key={v.code}>
          <dt>
            {t.rich('codes.paidLine', {
              code: v.code,
              c: (x) => <span className="nowrap">{x}</span>,
            })}
          </dt>
          <dd>{minus(v.amount)}</dd>
        </Fragment>
      ))}
      {pricing.voucher > 0 && (
        <>
          <dt className="totals__due">{t('codes.due')}</dt>
          <dd className="totals__due">{formatEuro(pricing.due, locale)}</dd>
        </>
      )}
    </>
  );
}

const PROBLEMS = [
  'unknown',
  'inactive',
  'expired',
  'not_yet',
  'used_up',
  'already_used',
  'not_for_cards',
  'not_for_licenses',
  'min_goods',
  'empty',
  'blocked',
  'too_many',
  'voucher_for_licenses',
] as const;

/** Why a code does nothing, in the visitor's words. */
export function CodeProblemText({
  problem,
  minGoodsCents,
  locale,
}: {
  problem: string;
  minGoodsCents?: number;
  locale: 'de' | 'en';
}) {
  const t = useTranslations('Codes');
  const key = (PROBLEMS as readonly string[]).includes(problem) ? problem : 'unknown';
  return (
    <>{t(key as (typeof PROBLEMS)[number], { min: formatEuro(minGoodsCents ?? 0, locale) })}</>
  );
}
