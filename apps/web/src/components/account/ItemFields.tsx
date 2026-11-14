import { getTranslations } from 'next-intl/server';
import { CARD_LANGUAGES, CONDITIONS, FINISHES, GRADING_COMPANIES } from '@pokeshop/core/catalog';
import type { Binder } from '@pokeshop/core/collection';

export type ItemValues = {
  language?: string;
  finish?: string;
  condition?: string;
  quantity?: number | string;
  purchasePrice?: string;
  binderId?: number | null;
  note?: string | null;
  gradingCompany?: string | null;
  gradingGrade?: string | null;
};

/** The fields of a collection line, for adding a card and for editing a line. */
export async function ItemFields({
  values,
  finishes,
  binders,
  errors = {},
  idPrefix,
}: {
  values: ItemValues;
  /** printings the card has; others are listed after them */
  finishes: string[];
  binders: Binder[];
  errors?: Record<string, string>;
  idPrefix: string;
}) {
  const t = await getTranslations('Portal.item');
  const tl = await getTranslations('Languages');
  const tf = await getTranslations('Finishes');
  const tc = await getTranslations('Conditions');
  const otherFinishes = Object.keys(FINISHES).filter((f) => !finishes.includes(f));
  const err = (k: string) =>
    errors[k] ? (
      <small className="field__error">
        {t(`errors.${errors[k] === 'too_large' ? 'too_large' : 'invalid'}`)}
      </small>
    ) : null;
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <div className="item-fields">
      <label className="field" htmlFor={id('language')}>
        <span>{t('language')}</span>
        <select id={id('language')} name="language" defaultValue={values.language ?? 'EN'}>
          {CARD_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {tl(l)}
            </option>
          ))}
        </select>
      </label>
      <label className="field" htmlFor={id('finish')}>
        <span>{t('finish')}</span>
        <select
          id={id('finish')}
          name="finish"
          defaultValue={values.finish ?? finishes[0] ?? 'normal'}
        >
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
      <label className="field" htmlFor={id('condition')}>
        <span>{t('condition')}</span>
        <select id={id('condition')} name="condition" defaultValue={values.condition ?? 'NM'}>
          {Object.keys(CONDITIONS).map((c) => (
            <option key={c} value={c}>
              {c} – {tc(c as never)}
            </option>
          ))}
        </select>
      </label>
      <label className={errors.quantity ? 'field field--error' : 'field'} htmlFor={id('quantity')}>
        <span>{t('quantity')}</span>
        <input
          id={id('quantity')}
          name="quantity"
          type="number"
          inputMode="numeric"
          min={1}
          max={999}
          defaultValue={values.quantity ?? 1}
        />
        {err('quantity')}
      </label>
      <label
        className={errors.purchase_price_cents ? 'field field--error' : 'field'}
        htmlFor={id('price')}
      >
        <span>{t('purchasePrice')}</span>
        <input
          id={id('price')}
          name="purchase_price"
          inputMode="decimal"
          placeholder="0,00"
          defaultValue={values.purchasePrice ?? ''}
        />
        {err('purchase_price_cents') ?? <small className="muted">{t('purchasePriceHint')}</small>}
      </label>
      <label className="field" htmlFor={id('binder')}>
        <span>{t('binder')}</span>
        <select
          id={id('binder')}
          name="binder"
          defaultValue={values.binderId ? String(values.binderId) : ''}
        >
          <option value="">{t('mainCollection')}</option>
          {binders.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <details
        className="item-fields__more"
        open={Boolean(values.gradingCompany || values.note) || undefined}
      >
        <summary>{t('more')}</summary>
        <div className="field-row">
          <label className="field" htmlFor={id('gc')}>
            <span>{t('grading')}</span>
            <select id={id('gc')} name="grading_company" defaultValue={values.gradingCompany ?? ''}>
              <option value="">{t('notGraded')}</option>
              {GRADING_COMPANIES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor={id('gg')}>
            <span>{t('grade')}</span>
            <input
              id={id('gg')}
              name="grading_grade"
              maxLength={10}
              defaultValue={values.gradingGrade ?? ''}
              placeholder="10"
            />
          </label>
        </div>
        <label className="field" htmlFor={id('note')}>
          <span>{t('note')}</span>
          <input id={id('note')} name="note" maxLength={500} defaultValue={values.note ?? ''} />
        </label>
      </details>
    </div>
  );
}
