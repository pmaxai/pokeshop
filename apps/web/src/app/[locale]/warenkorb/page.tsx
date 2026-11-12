import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro, formatRate, vatFor } from '@pokeshop/core';
import { loadCart, type CartView } from '@pokeshop/core/cart';
import { cartCodes, priceCartCodes } from '@pokeshop/core/vouchers';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db, getSetting } from '@/server/config';
import { currentCartId } from '@/server/cart';
import { AltNames } from '@/components/AltNames';
import { CardImage } from '@/components/CardImage';
import { AutoSubmit } from '@/components/AutoSubmit';
import { CodeLines, CodeProblemText } from '@/components/CodeLines';
import { cartCodeAction, updateCartAction } from '../shop-actions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<Record<string, string | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Cart' });
  return { title: t('title'), robots: { index: false } };
}

export default async function CartPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const t = await getTranslations('Cart');
  const tl = await getTranslations('Languages');
  const tc = await getTranslations('Card');
  const cartId = await currentCartId();
  const view: CartView | null = cartId ? await loadCart(db(), cartId, locale) : null;
  const names = new Intl.DisplayNames([locale === 'de' ? 'de-AT' : 'en'], { type: 'region' });
  // Delivery countries in the select, alphabetical by their name in the page's language.
  const byCountryName = <T extends { code: string }>(list: T[]) =>
    [...list].sort((a, b) =>
      (names.of(a.code) ?? a.code).localeCompare(names.of(b.code) ?? b.code, locale),
    );
  const threshold = await getSetting<number | null>('high_value_threshold_cents', null);

  const notices = [
    sp.added && { kind: 'ok', text: t('added') },
    sp.limited && { kind: 'warn', text: t('limited') },
    sp.unavailable && { kind: 'warn', text: t('unavailableAdd') },
    sp.cancelled && { kind: 'warn', text: t('cancelled') },
    sp.code === 'voucher' && { kind: 'ok', text: t('codes.addedVoucher') },
    sp.code === 'discount' && { kind: 'ok', text: t('codes.addedDiscount') },
    sp.code === 'replaced' && { kind: 'ok', text: t('codes.replaced') },
  ].filter(Boolean) as { kind: string; text: string }[];

  if (!view || view.lines.length === 0) {
    return (
      <div className="wrap cart-page">
        <h1>{t('title')}</h1>
        {notices.map((n) => (
          <p key={n.text} className={`notice notice--${n.kind}`} role="status">
            {n.text}
          </p>
        ))}
        <div className="empty">
          <p>{t('empty')}</p>
          <Link href="/karten" className="btn btn--accent">
            {t('emptyCta')}
          </Link>
        </div>
      </div>
    );
  }

  const problems = new Map<number, { requested: number; available: number }>();
  for (const p of view.check.problems) if (p.code === 'unavailable') problems.set(p.productId, p);
  const minimum = view.check.problems.find((p) => p.code === 'below_minimum');
  const country = view.countries.find((c) => c.code === view.country);
  const ship = view.check.shipping;
  const codes = await priceCartCodes(db(), {
    codes: await cartCodes(db(), view.id),
    lines: view.lines.map((l) => l.lineTotal),
    shipping: ship?.price ?? 0,
  });
  const price = codes.pricing;
  const vat = vatFor({
    country: view.country,
    ossEnabled: await getSetting<boolean>('oss_enabled', false),
    smallBusiness: await getSetting<boolean>('small_business', false),
    rates: country ? { [view.country]: country.vat_rate_bp } : undefined,
  });

  return (
    <div className="wrap cart-page">
      <h1>{t('title')}</h1>
      {notices.map((n) => (
        <p key={n.text} className={`notice notice--${n.kind}`} role="status">
          {n.text}
        </p>
      ))}
      <form id="cart-form" action={updateCartAction} className="cart">
        <input type="hidden" name="locale" value={locale} />
        <ul className="cart-lines">
          {view.lines.map((l) => {
            const problem = problems.get(l.id);
            const max = Math.max(l.quantity, Math.min(l.available, 99));
            return (
              <li key={l.id} className="cart-line">
                <Link
                  href={{ pathname: '/karten/[slug]', params: { slug: l.slug } }}
                  className="cart-line__img"
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  <CardImage image={l.image} alt="" sizes="5rem" noImageLabel={tc('noImage')} />
                </Link>
                <div className="cart-line__body">
                  <Link
                    href={{ pathname: '/karten/[slug]', params: { slug: l.slug } }}
                    className="cart-line__name"
                    lang={l.nameLang}
                  >
                    {l.name}
                  </Link>
                  <AltNames translations={l.nameTranslations} className="cart-line__alt" />
                  <span className="cart-line__set">
                    {l.setName ?? l.setCode} <span className="num">{l.cardNumber}</span> ·{' '}
                    {tl(l.cardLanguage as never)} · {l.condition}
                  </span>
                  {problem && (
                    <span className="cart-line__problem">
                      {problem.available > 0
                        ? t('onlyLeft', { count: problem.available })
                        : t('soldOut')}
                    </span>
                  )}
                </div>
                <label className="cart-line__qty">
                  <span className="visually-hidden">
                    {t('quantity')}: {l.name}
                  </span>
                  <select name={`qty_${l.id}`} defaultValue={String(l.quantity)}>
                    {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="cart-line__price">
                  {formatEuro(l.lineTotal, locale)}
                  {l.quantity > 1 && (
                    <small>
                      {t('each')} {formatEuro(l.priceCents, locale)}
                    </small>
                  )}
                </span>
                <button
                  type="submit"
                  name="remove"
                  value={l.id}
                  className="btn btn--quiet cart-line__remove"
                >
                  {t('remove')}
                </button>
              </li>
            );
          })}
        </ul>

        <aside className="summary" aria-labelledby="summary-title">
          <h2 id="summary-title">{t('summary')}</h2>
          <label className="field">
            <span>{t('country')}</span>
            <select name="country" defaultValue={view.country}>
              {byCountryName(view.countries).map((c) => (
                <option key={c.code} value={c.code}>
                  {names.of(c.code)}
                </option>
              ))}
            </select>
          </label>
          <noscript>
            <button type="submit" className="btn">
              {t('update')}
            </button>
          </noscript>
          <dl className="totals">
            <dt>{t('goods')}</dt>
            <dd>{formatEuro(view.check.goodsSubtotal, locale)}</dd>
            <dt>
              {ship?.method === 'insured'
                ? t('shippingInsured')
                : ship?.method === 'tracked'
                  ? t('shippingTracked')
                  : t('shipping')}
            </dt>
            <dd>{ship && ship.price > 0 ? formatEuro(ship.price, locale) : t('shippingFree')}</dd>
            <CodeLines pricing={price} locale={locale} />
          </dl>
          <div className="codes" id="codes">
            {codes.entries.length > 0 && (
              <ul className="codes__list">
                {codes.entries.map((e) => (
                  <li
                    key={e.code}
                    className={
                      e.kind === 'invalid' ? 'codes__entry codes__entry--bad' : 'codes__entry'
                    }
                  >
                    <span>
                      <span className="codes__code">{e.code}</span>
                      <small>
                        {e.kind === 'invalid' ? (
                          <CodeProblemText
                            problem={e.problem!}
                            minGoodsCents={e.minGoodsCents}
                            locale={locale}
                          />
                        ) : e.amount === 0 ? (
                          t('codes.notNeeded')
                        ) : e.kind === 'voucher' ? (
                          t('codes.voucherLeft', {
                            rest: formatEuro((e.balance ?? 0) - e.amount, locale),
                          })
                        ) : (
                          t('codes.discountApplied')
                        )}
                      </small>
                    </span>
                    <button
                      type="submit"
                      form="code-form"
                      name="remove_code"
                      value={e.code}
                      className="btn btn--quiet codes__remove"
                      aria-label={t('codes.removeLabel', { code: e.code })}
                    >
                      {t('remove')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label className={sp.code_error ? 'field field--error' : 'field'} htmlFor="code-input">
              <span>{t('codes.title')}</span>
              <span className="codes__row">
                <input
                  id="code-input"
                  name="code"
                  form="code-form"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  defaultValue={sp.code_error ? (sp.typed ?? '') : ''}
                  aria-invalid={sp.code_error ? true : undefined}
                  aria-describedby={sp.code_error ? 'code-error' : 'code-hint'}
                />
                <button type="submit" form="code-form" className="btn">
                  {t('codes.apply')}
                </button>
              </span>
              {sp.code_error ? (
                <small id="code-error" className="field__error">
                  <CodeProblemText
                    problem={sp.code_error}
                    minGoodsCents={sp.min ? Number(sp.min) : undefined}
                    locale={locale}
                  />
                </small>
              ) : (
                <small id="code-hint" className="muted">
                  {t('codes.hint')}
                </small>
              )}
            </label>
          </div>
          <p className="muted small">
            {vat.regime === 'small_business'
              ? t('noVat')
              : t('vat', { rate: formatRate(vat.rate, locale) })}
          </p>
          {ship?.method === 'insured' && country && threshold !== null && (
            <p className="small">
              {t('insuredNote', {
                threshold: formatEuro(threshold, locale),
                rate: formatRate(country.insured_rate_bp, locale),
                minimum: formatEuro(country.insured_minimum_cents, locale),
              })}
            </p>
          )}
          {ship?.method === 'tracked' && country?.insured_max_order_cents != null && (
            <p className="small">
              {t('trackedNote', { limit: formatEuro(country.insured_max_order_cents, locale) })}
            </p>
          )}
          {minimum && minimum.code === 'below_minimum' && (
            <p className="notice notice--warn">
              {t('belowMinimum', {
                country: names.of(view.country) ?? view.country,
                minimum: formatEuro(minimum.minimum, locale),
                missing: formatEuro(minimum.missing, locale),
              })}
            </p>
          )}
          {view.check.ok ? (
            <Link href="/kasse" className="btn btn--accent btn--wide">
              {t('toCheckout')}
            </Link>
          ) : (
            <span className="btn btn--wide" aria-disabled="true">
              {t('toCheckout')}
            </span>
          )}
          <p className="muted small">{t('holdNote')}</p>
        </aside>
      </form>
      {/* Code entry: its fields sit in the summary above (form="code-form"). */}
      <form id="code-form" action={cartCodeAction} hidden>
        <input type="hidden" name="locale" value={locale} />
      </form>
      <AutoSubmit formId="cart-form" />
    </div>
  );
}
