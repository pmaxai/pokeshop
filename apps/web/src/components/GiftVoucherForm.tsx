'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatEuro } from '@pokeshop/core/money';
import { Link } from '@/i18n/navigation';

export type GiftVoucherFormProps = {
  action: (form: FormData) => void | Promise<void>;
  locale: 'de' | 'en';
  presets: readonly number[];
  minCents: number;
  maxCents: number;
  values: Record<string, string>;
  /** Messages already translated, by field. */
  errors: Record<string, string>;
};

/**
 * Amount, name and message, with the voucher beside it as it will look on paper. The code is
 * made once the payment is in, so the preview shows a placeholder.
 */
export function GiftVoucherForm(p: GiftVoucherFormProps) {
  const t = useTranslations('Vouchers');
  const tc = useTranslations('Checkout');
  const initial = Number(p.values.amount || 2500);
  const isPreset = (p.presets as readonly number[]).includes(initial);
  const [choice, setChoice] = useState<string>(isPreset ? String(initial) : 'own');
  const [own, setOwn] = useState(isPreset ? '' : String(Math.round(initial / 100)));
  const [recipient, setRecipient] = useState(p.values.recipientName ?? '');
  const [message, setMessage] = useState(p.values.message ?? '');

  const ownCents = Math.round(Number(own.replace(',', '.')) * 100);
  const cents = choice === 'own' ? ownCents : Number(choice);
  const valid =
    Number.isFinite(cents) && cents >= p.minCents && cents <= p.maxCents && cents % 100 === 0;

  const err = (k: string) => p.errors[k];
  const field = (
    name: string,
    label: string,
    opts: { type?: string; autoComplete?: string; required?: boolean; hint?: string } = {},
  ) => (
    <label className={err(name) ? 'field field--error' : 'field'} htmlFor={`gv-${name}`}>
      <span>{label}</span>
      <input
        id={`gv-${name}`}
        name={name}
        type={opts.type ?? 'text'}
        defaultValue={p.values[name] ?? ''}
        autoComplete={opts.autoComplete}
        required={opts.required ?? true}
        aria-invalid={err(name) ? true : undefined}
        aria-describedby={err(name) ? `gv-${name}-err` : opts.hint ? `gv-${name}-hint` : undefined}
      />
      {err(name) ? (
        <small id={`gv-${name}-err`} className="field__error">
          {err(name)}
        </small>
      ) : (
        opts.hint && (
          <small id={`gv-${name}-hint`} className="muted">
            {opts.hint}
          </small>
        )
      )}
    </label>
  );

  return (
    <div className="gv">
      <figure className="gv-card" aria-label={t('previewLabel')}>
        <div className="gv-card__top">
          <span className="gv-card__brand">
            pokemonkarten<span>.at</span>
          </span>
          <span className="gv-card__kind">{t('previewKind')}</span>
        </div>
        <p className="gv-card__value" aria-live="polite">
          {valid ? formatEuro(cents, p.locale) : '–'}
        </p>
        <p className="gv-card__for">
          {recipient.trim() ? t('previewFor', { name: recipient.trim() }) : ' '}
        </p>
        <p className="gv-card__message">{message.trim() ? `„${message.trim()}“` : ''}</p>
        <div className="gv-card__foot">
          <span className="gv-card__code">
            <small>{t('previewCode')}</small>
            XXXX-XXXX-XXXX
          </span>
          <span className="gv-card__terms">{t('previewTerms')}</span>
        </div>
        <figcaption className="visually-hidden">{t('previewCaption')}</figcaption>
      </figure>

      <form action={p.action} className="gv-form" noValidate>
        <input type="hidden" name="locale" value={p.locale} />
        <input type="hidden" name="amount" value={valid ? String(cents) : ''} />
        <fieldset className={err('amountCents') ? 'gv-amounts gv-amounts--error' : 'gv-amounts'}>
          <legend>{t('amount')}</legend>
          <div className="gv-amounts__row">
            {p.presets.map((c) => (
              <label key={c} className="gv-amount">
                <input
                  type="radio"
                  name="amount_choice"
                  value={String(c)}
                  checked={choice === String(c)}
                  onChange={() => setChoice(String(c))}
                />
                <span>{formatEuro(c, p.locale).replace(/[,.]00/, '')}</span>
              </label>
            ))}
            <label className="gv-amount gv-amount--own">
              <input
                type="radio"
                name="amount_choice"
                value="own"
                checked={choice === 'own'}
                onChange={() => setChoice('own')}
              />
              <span>{t('ownAmount')}</span>
            </label>
          </div>
          {choice === 'own' && (
            <label className="field gv-own" htmlFor="gv-own">
              <span>{t('ownAmountLabel')}</span>
              <span className="gv-own__input">
                <input
                  id="gv-own"
                  inputMode="numeric"
                  value={own}
                  onChange={(e) => setOwn(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
                  aria-describedby="gv-own-hint"
                  autoFocus={!isPreset && !own}
                />
                <span aria-hidden="true">€</span>
              </span>
              <small id="gv-own-hint" className={err('amountCents') ? 'field__error' : 'muted'}>
                {err('amountCents') ??
                  t('ownAmountHint', {
                    min: formatEuro(p.minCents, p.locale),
                    max: formatEuro(p.maxCents, p.locale),
                  })}
              </small>
            </label>
          )}
          {choice !== 'own' && err('amountCents') && (
            <small className="field__error">{err('amountCents')}</small>
          )}
        </fieldset>

        <fieldset>
          <legend>{t('personal')}</legend>
          <label className="field" htmlFor="gv-recipient">
            <span>{t('recipient')}</span>
            <input
              id="gv-recipient"
              name="recipientName"
              value={recipient}
              maxLength={80}
              onChange={(e) => setRecipient(e.target.value)}
              aria-describedby="gv-recipient-hint"
            />
            <small id="gv-recipient-hint" className="muted">
              {t('recipientHint')}
            </small>
          </label>
          <label className="field" htmlFor="gv-message">
            <span>{t('message')}</span>
            <textarea
              id="gv-message"
              name="message"
              rows={3}
              maxLength={300}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              aria-describedby="gv-message-hint"
            />
            <small id="gv-message-hint" className="muted">
              {t('messageHint', { left: 300 - message.length })}
            </small>
          </label>
        </fieldset>

        <fieldset>
          <legend>{t('you')}</legend>
          {field('name', t('name'), { autoComplete: 'name' })}
          {field('email', t('email'), {
            type: 'email',
            autoComplete: 'email',
            hint: t('emailHint'),
          })}
        </fieldset>

        <div className="gv-order">
          <p className="gv-order__total">
            <span>{t('total')}</span>
            <strong>{valid ? formatEuro(cents, p.locale) : '–'}</strong>
          </p>
          <label className={err('acceptTerms') ? 'check check--error' : 'check'}>
            <input
              type="checkbox"
              name="accept_terms"
              required
              aria-invalid={err('acceptTerms') ? true : undefined}
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
              })}
            </span>
          </label>
          {err('acceptTerms') && <small className="field__error">{err('acceptTerms')}</small>}
          <button type="submit" className="btn btn--accent btn--wide">
            {tc('submit')}
          </button>
          <p className="muted small">{t('submitNote')}</p>
        </div>
      </form>
    </div>
  );
}
