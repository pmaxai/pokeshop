import { getTranslations } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import { CARD_LANGUAGES, CONDITIONS, FINISHES } from '@pokeshop/core/catalog';

export type Wishes = {
  language: string | null;
  finish: string | null;
  minCondition: string | null;
  maxPriceCents: number | null;
};

/** The optional wishes for a missing card: language, printing, condition, price. */
export async function WantedFields({
  finishes,
  errors = {},
}: {
  /** printings the card has; others are listed after them */
  finishes: string[];
  errors?: Record<string, string>;
}) {
  const t = await getTranslations('Portal.wanted');
  const tl = await getTranslations('Languages');
  const tf = await getTranslations('Finishes');
  const tc = await getTranslations('Conditions');
  const otherFinishes = Object.keys(FINISHES).filter((f) => !finishes.includes(f));
  return (
    <div className="item-fields">
      <label className="field" htmlFor="w-language">
        <span>{t('language')}</span>
        <select id="w-language" name="language" defaultValue="">
          <option value="">{t('any')}</option>
          {CARD_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {tl(l)}
            </option>
          ))}
        </select>
      </label>
      <label className="field" htmlFor="w-finish">
        <span>{t('finish')}</span>
        <select id="w-finish" name="finish" defaultValue="">
          <option value="">{t('any')}</option>
          {finishes.map((f) => (
            <option key={f} value={f}>
              {tf(f as never)}
            </option>
          ))}
          {otherFinishes.length > 0 && (
            <optgroup label={t('otherFinishes')}>
              {otherFinishes.map((f) => (
                <option key={f} value={f}>
                  {tf(f as never)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <label className="field" htmlFor="w-condition">
        <span>{t('minCondition')}</span>
        <select id="w-condition" name="min_condition" defaultValue="">
          <option value="">{t('any')}</option>
          {Object.keys(CONDITIONS).map((c) => (
            <option key={c} value={c}>
              {c} – {tc(c as never)}
            </option>
          ))}
        </select>
      </label>
      <label className={errors.max_price_cents ? 'field field--error' : 'field'} htmlFor="w-price">
        <span>{t('maxPrice')}</span>
        <input
          id="w-price"
          name="max_price"
          inputMode="decimal"
          autoComplete="off"
          placeholder={t('maxPricePlaceholder')}
          aria-invalid={errors.max_price_cents ? true : undefined}
        />
        {errors.max_price_cents && <small className="field__error">{t('priceError')}</small>}
      </label>
      <label className="field item-fields__wide" htmlFor="w-note">
        <span>{t('note')}</span>
        <input id="w-note" name="note" maxLength={500} placeholder={t('notePlaceholder')} />
      </label>
    </div>
  );
}

/** The wishes as short tags; "any" ones are left out. */
export async function WishTags({ w, locale }: { w: Wishes; locale: 'de' | 'en' }) {
  const t = await getTranslations('Portal.wanted');
  const tl = await getTranslations('Languages');
  const tf = await getTranslations('Finishes');
  const tags = [
    w.language ? tl(w.language as never) : t('anyLanguage'),
    w.finish ? tf(w.finish as never) : null,
    w.minCondition ? t('fromCondition', { condition: w.minCondition }) : null,
    w.maxPriceCents ? t('upTo', { price: formatEuro(w.maxPriceCents, locale) }) : null,
  ].filter((x): x is string => !!x);
  return (
    <span className="collection-list__tags">
      {tags.map((x) => (
        <span key={x} className="tag">
          {x}
        </span>
      ))}
    </span>
  );
}
