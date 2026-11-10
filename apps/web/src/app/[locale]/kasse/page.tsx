import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import { loadCart } from '@pokeshop/core/cart';
import { cartCodes, priceCartCodes } from '@pokeshop/core/vouchers';
import { Link, getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { currentCartId } from '@/server/cart';
import { AltNames } from '@/components/AltNames';
import { CodeLines } from '@/components/CodeLines';
import { checkoutAction } from '../shop-actions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ e?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Checkout' });
  return { title: t('title'), robots: { index: false } };
}

type Draft = {
  email?: string;
  phone?: string;
  shipping?: Record<string, string>;
  billing?: Record<string, string>;
  billingDiffers?: boolean;
};

function unpack(s: string | undefined): Record<string, string> {
  if (!s) return {};
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export default async function CheckoutPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Checkout');
  const tCart = await getTranslations('Cart');
  const cartId = await currentCartId();
  const view = cartId ? await loadCart(db(), cartId, locale) : null;
  if (!view || view.lines.length === 0 || !view.check.ok) {
    redirect(getPathname({ href: '/warenkorb', locale }));
  }
  const errors = unpack((await searchParams).e);
  const draft = (view.checkoutDraft ?? {}) as Draft;
  const names = new Intl.DisplayNames([locale === 'de' ? 'de-AT' : 'en'], { type: 'region' });
  const err = (key: string) => {
    const code = errors[key];
    return code ? t(`errors.${code}` as never) : null;
  };
  const ship = view.check.shipping!;
  const codes = await priceCartCodes(db(), {
    codes: await cartCodes(db(), view.id),
    lines: view.lines.map((l) => l.lineTotal),
    shipping: ship.price,
  });
  const allCountries = (await db()<{ code: string }[]>`SELECT code FROM countries`)
    .map((c) => ({ code: c.code, name: names.of(c.code) ?? c.code }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));

  const field = (
    name: string,
    label: string,
    value: string | undefined,
    opts: {
      type?: string;
      autoComplete?: string;
      required?: boolean;
      hint?: string;
      inputMode?: 'numeric' | 'email' | 'tel';
    } = {},
  ) => {
    const e = err(name);
    const id = `f-${name.replace('.', '-')}`;
    return (
      <label className={e ? 'field field--error' : 'field'} htmlFor={id}>
        <span>{label}</span>
        <input
          id={id}
          name={name}
          type={opts.type ?? 'text'}
          defaultValue={value ?? ''}
          autoComplete={opts.autoComplete}
          required={opts.required ?? true}
          inputMode={opts.inputMode}
          aria-invalid={e ? true : undefined}
          aria-describedby={e ? `${id}-err` : opts.hint ? `${id}-hint` : undefined}
        />
        {e ? (
          <small id={`${id}-err`} className="field__error">
            {e}
          </small>
        ) : (
          opts.hint && (
            <small id={`${id}-hint`} className="muted">
              {opts.hint}
            </small>
          )
        )}
      </label>
    );
  };

  const addressFields = (
    prefix: 'shipping' | 'billing',
    values: Record<string, string> | undefined,
    section: string,
  ) => (
    <>
      {field(`${prefix}.name`, t('name'), values?.name, { autoComplete: `${section} name` })}
      {field(`${prefix}.company`, t('company'), values?.company, {
        autoComplete: `${section} organization`,
        required: false,
      })}
      {field(`${prefix}.street`, t('street'), values?.street, {
        autoComplete: `${section} street-address`,
      })}
      <div className="field-row">
        {field(`${prefix}.postcode`, t('postcode'), values?.postcode, {
          autoComplete: `${section} postal-code`,
          inputMode: 'numeric',
        })}
        {field(`${prefix}.city`, t('city'), values?.city, {
          autoComplete: `${section} address-level2`,
        })}
      </div>
    </>
  );

  return (
    <div className="wrap checkout-page">
      <h1>{t('title')}</h1>
      {Object.keys(errors).length > 0 && (
        <p className="notice notice--warn" role="alert">
          {errors._ === 'payment_unavailable' ? t('paymentUnavailable') : t('errorsTitle')}
        </p>
      )}
      <form action={checkoutAction} className="checkout" noValidate>
        <input type="hidden" name="locale" value={locale} />
        <div className="checkout__fields">
          <fieldset>
            <legend>{t('contact')}</legend>
            {field('email', t('email'), draft.email, {
              type: 'email',
              autoComplete: 'email',
              hint: t('emailHint'),
              inputMode: 'email',
            })}
            {field('phone', t('phone'), draft.phone, {
              type: 'tel',
              autoComplete: 'tel',
              required: false,
              inputMode: 'tel',
            })}
          </fieldset>
          <fieldset>
            <legend>{t('address')}</legend>
            {addressFields('shipping', draft.shipping, 'shipping')}
            <label className="field" htmlFor="f-shipping-country">
              <span>{t('country')}</span>
              <select
                id="f-shipping-country"
                name="shipping.country"
                defaultValue={view.country}
                autoComplete="shipping country"
              >
                {view.countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {names.of(c.code)}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          <details className="billing" open={draft.billingDiffers || undefined}>
            <summary>
              <label className="check">
                <input
                  type="checkbox"
                  name="billing_differs"
                  defaultChecked={draft.billingDiffers}
                />{' '}
                {t('billingToggle')}
              </label>
            </summary>
            <fieldset>
              <legend>{t('billing')}</legend>
              {addressFields('billing', draft.billing, 'billing')}
              <label className="field" htmlFor="f-billing-country">
                <span>{t('country')}</span>
                <select
                  id="f-billing-country"
                  name="billing.country"
                  defaultValue={draft.billing?.country ?? view.country}
                  autoComplete="billing country"
                >
                  {allCountries.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
          </details>
        </div>

        <aside className="summary" aria-labelledby="order-title">
          <h2 id="order-title">{t('yourOrder')}</h2>
          <ul className="summary__lines">
            {view.lines.map((l) => (
              <li key={l.id}>
                <span>
                  {l.quantity > 1 ? `${l.quantity} × ` : ''}
                  <span lang={l.nameLang}>{l.name}</span>{' '}
                  <span className="num muted">{l.cardNumber}</span>
                  {l.nameTranslations.length > 0 && (
                    <>
                      <br />
                      <AltNames translations={l.nameTranslations} className="muted summary__alt" />
                    </>
                  )}
                </span>
                <span>{formatEuro(l.lineTotal, locale)}</span>
              </li>
            ))}
          </ul>
          <dl className="totals">
            <dt>{tCart('goods')}</dt>
            <dd>{formatEuro(view.check.goodsSubtotal, locale)}</dd>
            <dt>
              {ship.method === 'insured'
                ? tCart('shippingInsured')
                : ship.method === 'tracked'
                  ? tCart('shippingTracked')
                  : tCart('shipping')}
            </dt>
            <dd>{ship.price > 0 ? formatEuro(ship.price, locale) : tCart('shippingFree')}</dd>
            <CodeLines pricing={codes.pricing} locale={locale} />
          </dl>
          {codes.entries.length === 0 && (
            <p className="small">
              <Link href={{ pathname: '/warenkorb', hash: 'codes' }}>
                {tCart('codes.checkoutLink')}
              </Link>
            </p>
          )}
          <label className={errors.acceptTerms ? 'check check--error' : 'check'}>
            <input
              type="checkbox"
              name="accept_terms"
              required
              aria-invalid={errors.acceptTerms ? true : undefined}
            />
            <span>
              {t.rich('terms', {
                terms: (c) => (
                  <Link href="/agb" target="_blank">
                    {c}
                  </Link>
                ),
                withdrawal: (c) => (
                  <Link href="/widerrufsbelehrung" target="_blank">
                    {c}
                  </Link>
                ),
                privacy: (c) => (
                  <Link href="/datenschutz" target="_blank">
                    {c}
                  </Link>
                ),
              })}
            </span>
          </label>
          {errors.acceptTerms && <small className="field__error">{t('errors.terms')}</small>}
          <button type="submit" className="btn btn--accent btn--wide">
            {t('submit')}
          </button>
          <p className="muted small">{t('submitNote')}</p>
          <Link href="/warenkorb" className="small">
            {t('back')}
          </Link>
        </aside>
      </form>
    </div>
  );
}
