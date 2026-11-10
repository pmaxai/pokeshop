'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { formatEuro } from '@pokeshop/core/money';
import { Link } from '@/i18n/navigation';

type Country = { code: string; name: string };

export type LicenseFormProps = {
  action: (form: FormData) => void | Promise<void>;
  locale: 'de' | 'en';
  values: Record<string, string>;
  /** Messages already translated, by field. */
  errors: Record<string, string>;
  euCountries: Country[];
  /** Business buyers only (CH, LI, NO, IS, GB, US, CA, AU). */
  otherCountries: Country[];
  grossCents: number;
  netCents: number;
  max: number;
  sellerName: string;
  sellerAddress: string;
  title: ReactNode;
};

const HOME = 'AT';

/**
 * The licence order form. Private or business buyer decides which countries are offered,
 * whether company and tax id are asked for, and whether the price is shown with VAT or net
 * (business abroad: reverse charge or not taxable in Austria). The server checks all of it
 * again, and VIES the EU VAT id.
 */
export function LicenseForm(p: LicenseFormProps) {
  const t = useTranslations('App.form');
  const tc = useTranslations('Checkout');
  const [business, setBusiness] = useState(p.values.buyer === 'business');
  const [country, setCountry] = useState(p.values.country || (p.locale === 'de' ? HOME : ''));
  const [vatId, setVatId] = useState(p.values.vatId ?? '');
  const [quantity, setQuantity] = useState(p.values.quantity || '1');

  const eu = p.euCountries.some((c) => c.code === country);
  const net = business && country !== '' && country !== HOME && (!eu || vatId.trim() !== '');
  const unit = net ? p.netCents : p.grossCents;
  const n = Number(quantity);
  const validQty = Number.isInteger(n) && n >= 1 && n <= p.max;
  const taxNote = !net ? t('inclVat') : eu ? t('reverseCharge') : t('notTaxable');
  const taxIdLabel = eu || country === '' ? t('vatId') : t('taxId');
  const taxIdHint =
    country === HOME
      ? t('vatIdHintHome')
      : eu || country === ''
        ? t('vatIdHintEu')
        : t(`taxIdHint.${country}` as 'taxIdHint.US');

  const countryError = country === (p.values.country ?? '') ? p.errors.country : undefined;

  const chooseBuyer = (b: boolean) => {
    setBusiness(b);
    // Private buyers only in the EU.
    if (!b && country && !p.euCountries.some((c) => c.code === country)) setCountry('');
  };

  const field = (
    name: string,
    label: string,
    opts: {
      type?: string;
      autoComplete?: string;
      required?: boolean;
      hint?: string;
      value?: string;
      onChange?: (v: string) => void;
    } = {},
  ) => {
    // A server message about a value the buyer has since changed no longer applies.
    const stale = opts.onChange && (opts.value ?? '') !== (p.values[name] ?? '');
    const e = stale ? undefined : p.errors[name];
    const id = `app-${name}`;
    const controlled = opts.onChange
      ? {
          value: opts.value ?? '',
          onChange: (ev: { target: { value: string } }) => opts.onChange!(ev.target.value),
        }
      : { defaultValue: p.values[name] ?? '' };
    return (
      <label className={e ? 'field field--error' : 'field'} htmlFor={id}>
        <span>{label}</span>
        <input
          id={id}
          name={name}
          type={opts.type ?? 'text'}
          {...controlled}
          autoComplete={opts.autoComplete}
          required={opts.required ?? true}
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

  return (
    <form action={p.action} className="checkout" noValidate>
      <input type="hidden" name="locale" value={p.locale} />
      <div className="checkout__fields">
        <fieldset className="buyer-type">
          <legend>{t('buyerTitle')}</legend>
          <label className="buyer-type__opt">
            <input
              type="radio"
              name="buyer"
              value="consumer"
              checked={!business}
              onChange={() => chooseBuyer(false)}
            />
            <span>
              <strong>{t('consumer')}</strong>
              <small>{t('consumerNote')}</small>
            </span>
          </label>
          <label className="buyer-type__opt">
            <input
              type="radio"
              name="buyer"
              value="business"
              checked={business}
              onChange={() => chooseBuyer(true)}
            />
            <span>
              <strong>{t('business')}</strong>
              <small>{t('businessNote')}</small>
            </span>
          </label>
        </fieldset>
        <fieldset>
          <legend className="visually-hidden">{p.title}</legend>
          {business && field('company', t('companyName'), { autoComplete: 'organization' })}
          {field('name', business ? t('contactName') : t('name'), { autoComplete: 'name' })}
          {field('email', t('email'), {
            type: 'email',
            autoComplete: 'email',
            hint: t('emailHint'),
          })}
          {field('street', t('street'), {
            autoComplete: 'billing street-address',
            hint: t('streetHint'),
          })}
          <div className="field-row">
            {field('postcode', t('postcode'), { autoComplete: 'billing postal-code' })}
            {field('city', t('city'), { autoComplete: 'billing address-level2' })}
          </div>
          <label className={countryError ? 'field field--error' : 'field'} htmlFor="app-country">
            <span>{t('country')}</span>
            <select
              id="app-country"
              name="country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              autoComplete="billing country"
              required
              aria-invalid={countryError ? true : undefined}
              aria-describedby={countryError ? 'app-country-err' : 'app-country-hint'}
            >
              <option value="">–</option>
              {business ? (
                <>
                  <optgroup label={t('countriesEu')}>
                    {p.euCountries.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t('countriesOther')}>
                    {p.otherCountries.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                </>
              ) : (
                p.euCountries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))
              )}
            </select>
            {countryError ? (
              <small id="app-country-err" className="field__error">
                {countryError}
              </small>
            ) : (
              <small id="app-country-hint" className="muted">
                {business ? t('countryHintBusiness') : t('countryHintConsumer')}
              </small>
            )}
          </label>
          {business &&
            field('vatId', taxIdLabel, {
              autoComplete: 'off',
              required: country !== '' && !eu,
              hint: taxIdHint,
              value: vatId,
              onChange: setVatId,
            })}
        </fieldset>
      </div>
      <aside className="summary" aria-labelledby="app-sum-title">
        <h3 id="app-sum-title">{p.title}</h3>
        <label
          className={p.errors.quantity ? 'field field--error' : 'field'}
          htmlFor="app-quantity"
        >
          <span>{t('quantity')}</span>
          <input
            id="app-quantity"
            name="quantity"
            type="number"
            inputMode="numeric"
            min={1}
            max={p.max}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            aria-describedby="app-quantity-hint"
            aria-invalid={p.errors.quantity ? true : undefined}
          />
          <small id="app-quantity-hint" className={p.errors.quantity ? 'field__error' : 'muted'}>
            {p.errors.quantity ??
              t('quantityHint', { max: p.max, price: formatEuro(unit, p.locale) })}
          </small>
        </label>
        <label className={p.errors.code ? 'field field--error' : 'field'} htmlFor="app-code">
          <span>{t('code')}</span>
          <input
            id="app-code"
            name="code"
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            defaultValue={p.values.code ?? ''}
            aria-invalid={p.errors.code ? true : undefined}
            aria-describedby="app-code-hint"
          />
          <small id="app-code-hint" className={p.errors.code ? 'field__error' : 'muted'}>
            {p.errors.code ?? t('codeHint')}
          </small>
        </label>
        <dl className="totals">
          <dt className="totals__total">{net ? t('totalNet') : t('total')}</dt>
          <dd className="totals__total" aria-live="polite">
            {validQty ? formatEuro(unit * n, p.locale) : '–'}
          </dd>
        </dl>
        <p className="small muted" aria-live="polite">
          {taxNote}
        </p>
        <label className={p.errors.acceptTerms ? 'check check--error' : 'check'}>
          <input
            type="checkbox"
            name="accept_terms"
            required
            aria-invalid={p.errors.acceptTerms ? true : undefined}
          />
          <span>
            {t.rich('terms', {
              seller: p.sellerName,
              terms: (c) => (
                <Link href="/app/lizenzbedingungen" target="_blank">
                  {c}
                </Link>
              ),
            })}
          </span>
        </label>
        {p.errors.acceptTerms && <small className="field__error">{p.errors.acceptTerms}</small>}
        <label className={p.errors.immediateDelivery ? 'check check--error' : 'check'}>
          <input
            type="checkbox"
            name="immediate_delivery"
            required
            aria-invalid={p.errors.immediateDelivery ? true : undefined}
          />
          <span>{t('consent')}</span>
        </label>
        {p.errors.immediateDelivery && (
          <small className="field__error">{p.errors.immediateDelivery}</small>
        )}
        <button type="submit" className="btn btn--accent btn--wide">
          {tc('submit')}
        </button>
        <p className="muted small">{t('submitNote')}</p>
        <p className="muted small app-seller">
          {t('seller', { seller: p.sellerName, address: p.sellerAddress })}
        </p>
      </aside>
    </form>
  );
}
