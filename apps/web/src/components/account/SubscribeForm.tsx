'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatEuro } from '@pokeshop/core/money';
import { Link } from '@/i18n/navigation';

type Country = { code: string; name: string };
type Plan = 'collector' | 'creator';

export type PlanPrices = {
  /** gross (incl. VAT) and net (reverse charge) cents per month */
  collector: { gross: number; net: number };
  creator: { gross: number; net: number };
  collector_device: { gross: number; net: number };
  creator_device: { gross: number; net: number };
};

const HOME = 'AT';
const MAX_DEVICES = 20;

/**
 * Plan, extra devices and the billing details for the GmbH's invoice. Private or business buyer
 * decides whether company and VAT id are asked for, and whether prices are shown with VAT or
 * net (business elsewhere in the EU with a VAT id: reverse charge). The server checks it all
 * again, the VAT id with VIES.
 */
export function SubscribeForm(p: {
  action: (form: FormData) => void | Promise<void>;
  locale: 'de' | 'en';
  values: Record<string, string>;
  errors: Record<string, string>;
  euCountries: Country[];
  prices: PlanPrices;
  sellerName: string;
  sellerAddress: string;
  /**
   * Only extra devices, for a subscription bought in an app store: no plan to pick (it is the
   * store subscription's), at least one device, at most `max`.
   */
  devicesOnly?: { plan: Plan; max: number };
  /**
   * The affiliate code: `saved` = the account is registered for it (shown, not editable);
   * otherwise the field is offered, filled with the code from the visitor's link.
   */
  affiliate?: { code: string; percent: number; months: number | null; saved: boolean } | null;
}) {
  const t = useTranslations('Subscription.form');
  const tp = useTranslations('Subscription.plans');
  const only = p.devicesOnly;
  const [picked, setPlan] = useState<Plan>(p.values.plan === 'creator' ? 'creator' : 'collector');
  const plan = only?.plan ?? picked;
  const [devices, setDevices] = useState(p.values.extraDevices || (only ? '1' : '0'));
  const maxDevices = only?.max ?? MAX_DEVICES;
  const [business, setBusiness] = useState(p.values.buyer === 'business');
  const [country, setCountry] = useState(p.values.country || (p.locale === 'de' ? HOME : ''));
  const [vatId, setVatId] = useState(p.values.vatId ?? '');

  const net = business && country !== '' && country !== HOME && vatId.trim() !== '';
  const price = (k: keyof PlanPrices) => (net ? p.prices[k].net : p.prices[k].gross);
  const n = Number(devices);
  const validN = Number.isInteger(n) && n >= (only ? 1 : 0) && n <= maxDevices;
  const total = (only ? 0 : price(plan)) + (validN ? n : 0) * price(`${plan}_device`);
  const eur = (c: number) => formatEuro(c, p.locale);

  const field = (
    name: string,
    label: string,
    opts: {
      autoComplete?: string;
      required?: boolean;
      hint?: string;
      value?: string;
      onChange?: (v: string) => void;
    } = {},
  ) => {
    const stale = opts.onChange && (opts.value ?? '') !== (p.values[name] ?? '');
    const e = stale ? undefined : p.errors[name];
    const id = `sub-${name}`;
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
          type="text"
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

  const countryError = country === (p.values.country ?? '') ? p.errors.country : undefined;

  return (
    <form action={p.action} className="subscribe" noValidate>
      <input type="hidden" name="locale" value={p.locale} />
      {only && <input type="hidden" name="plan" value={only.plan} />}
      {!only && (
        <fieldset className="plan-pick">
          <legend>{t('planTitle')}</legend>
          {(['collector', 'creator'] as const).map((k) => (
            <label key={k} className="plan-pick__opt" data-plan={k}>
              <input
                type="radio"
                name="plan"
                value={k}
                checked={plan === k}
                onChange={() => setPlan(k)}
              />
              <span className="plan-pick__body">
                <span className="plan-pick__head">
                  <strong>{tp(`${k}.name`)}</strong>
                  <span className="plan-pick__price">
                    <span className="num">{eur(price(k))}</span> {t('perMonth')}
                  </span>
                </span>
                <span className="plan-pick__what">{tp(`${k}.short`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <label
        className={p.errors.extraDevices ? 'field field--error' : 'field'}
        htmlFor="sub-devices"
      >
        <span>{only ? t('devicesOnlyCount') : t('extraDevices')}</span>
        <input
          id="sub-devices"
          name="extraDevices"
          type="number"
          inputMode="numeric"
          min={only ? 1 : 0}
          max={maxDevices}
          step={1}
          value={devices}
          onChange={(e) => setDevices(e.target.value)}
          aria-describedby="sub-devices-hint"
          className="subscribe__devices"
        />
        <small id="sub-devices-hint" className={p.errors.extraDevices ? 'field__error' : 'muted'}>
          {p.errors.extraDevices ??
            t(only ? 'devicesOnlyHint' : 'extraDevicesHint', {
              price: eur(price(`${plan}_device`)),
            })}
        </small>
      </label>

      {!only &&
        (p.affiliate?.saved ? (
          <p className="notice subscribe__affiliate">
            {p.affiliate.percent > 0
              ? t('affiliateActive', {
                  code: p.affiliate.code,
                  percent: p.affiliate.percent,
                  months: p.affiliate.months ?? 0,
                })
              : t('affiliateActiveNoDiscount', { code: p.affiliate.code })}
          </p>
        ) : (
          <label
            className={p.errors.affiliateCode ? 'field field--error' : 'field'}
            htmlFor="sub-affiliateCode"
          >
            <span>{t('affiliateLabel')}</span>
            <input
              id="sub-affiliateCode"
              name="affiliateCode"
              type="text"
              defaultValue={p.values.affiliateCode ?? p.affiliate?.code ?? ''}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={30}
              className="subscribe__code"
              aria-invalid={p.errors.affiliateCode ? true : undefined}
              aria-describedby="sub-affiliateCode-hint"
            />
            <small
              id="sub-affiliateCode-hint"
              className={p.errors.affiliateCode ? 'field__error' : 'muted'}
            >
              {p.errors.affiliateCode ?? t('affiliateHint')}
            </small>
          </label>
        ))}

      <fieldset className="buyer-type">
        <legend>{t('buyerTitle')}</legend>
        <label className="buyer-type__opt">
          <input
            type="radio"
            name="buyer"
            value="consumer"
            checked={!business}
            onChange={() => setBusiness(false)}
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
            onChange={() => setBusiness(true)}
          />
          <span>
            <strong>{t('business')}</strong>
            <small>{t('businessNote')}</small>
          </span>
        </label>
      </fieldset>

      <fieldset className="subscribe__billing">
        <legend>{t('billingTitle')}</legend>
        {business && field('company', t('company'), { autoComplete: 'organization' })}
        {field('name', business ? t('contactName') : t('name'), { autoComplete: 'name' })}
        {field('street', t('street'), { autoComplete: 'billing street-address' })}
        <div className="field-row">
          {field('postcode', t('postcode'), { autoComplete: 'billing postal-code' })}
          {field('city', t('city'), { autoComplete: 'billing address-level2' })}
        </div>
        <label className={countryError ? 'field field--error' : 'field'} htmlFor="sub-country">
          <span>{t('country')}</span>
          <select
            id="sub-country"
            name="country"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            autoComplete="billing country"
            required
            aria-invalid={countryError ? true : undefined}
          >
            <option value="">–</option>
            {p.euCountries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
          {countryError ? (
            <small className="field__error">{countryError}</small>
          ) : (
            <small className="muted">{t('countryHint')}</small>
          )}
        </label>
        {business &&
          field('vatId', t('vatId'), {
            autoComplete: 'off',
            required: false,
            hint: country === HOME ? t('vatIdHintHome') : t('vatIdHintEu'),
            value: vatId,
            onChange: setVatId,
          })}
      </fieldset>

      <div className="subscribe__sum">
        <dl className="totals">
          <dt className="totals__total">{net ? t('totalNet') : t('total')}</dt>
          <dd className="totals__total" aria-live="polite">
            {validN ? `${eur(total)} ${t('perMonth')}` : '–'}
          </dd>
        </dl>
        <p className="small muted" aria-live="polite">
          {net ? t('reverseCharge') : t('inclVat')} {t('cancelAnytime')}
        </p>
        {!only && p.affiliate && p.affiliate.percent > 0 && validN && (
          <p className="small" aria-live="polite">
            {t('affiliateTotal', {
              price: eur(Math.round((total * (100 - p.affiliate.percent)) / 100)),
              months: p.affiliate.months ?? 0,
            })}
          </p>
        )}
        <label className={p.errors.acceptTerms ? 'check check--error' : 'check'}>
          <input type="checkbox" name="accept_terms" required />
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
        <label className={p.errors.immediateStart ? 'check check--error' : 'check'}>
          <input type="checkbox" name="immediate_start" required />
          <span>{t('consent')}</span>
        </label>
        {p.errors.immediateStart && (
          <small className="field__error">{p.errors.immediateStart}</small>
        )}
        <button type="submit" className="btn btn--accent btn--wide">
          {only ? t('devicesOnlySubmit') : t('submit')}
        </button>
        <p className="muted small">{only ? t('devicesOnlySubmitNote') : t('submitNote')}</p>
        <p className="muted small">
          {t('seller', { seller: p.sellerName, address: p.sellerAddress })}
        </p>
      </div>
    </form>
  );
}
