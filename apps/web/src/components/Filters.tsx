import { getTranslations } from 'next-intl/server';
import type { CatalogResult, Facet } from '@pokeshop/core/storefront';
import { CONDITIONS } from '@pokeshop/core';
import { AutoSubmit } from './AutoSubmit';

export type FilterState = {
  q?: string | undefined;
  cat: string[];
  lang: string[];
  series: string[];
  set: string[];
  rarity: string[];
  cond: string[];
  finish: string[];
  type: string[];
  graded: boolean;
  min?: string | undefined;
  max?: string | undefined;
  all: boolean;
  sort?: string | undefined;
};

const VISIBLE = 8;

function Group({
  name,
  legend,
  facets,
  selected,
  label,
  moreLabel,
}: {
  name: string;
  legend: string;
  facets: Facet[];
  selected: string[];
  label: (f: Facet) => string;
  moreLabel: (n: number) => string;
}) {
  if (facets.length === 0) return null;
  // selected options stay visible even when they sit beyond the first eight
  const top = facets.slice(0, VISIBLE);
  const rest = facets.slice(VISIBLE);
  const box = (f: Facet) => (
    <label key={f.value}>
      <input
        type="checkbox"
        name={name}
        value={f.value}
        defaultChecked={selected.includes(f.value)}
      />
      <span>{label(f)}</span>
      <span className="count">{f.count}</span>
    </label>
  );
  return (
    <fieldset>
      <legend>{legend}</legend>
      {top.map(box)}
      {rest.length > 0 && (
        <details className="more-options" open={rest.some((f) => selected.includes(f.value))}>
          <summary>{moreLabel(rest.length)}</summary>
          {rest.map(box)}
        </details>
      )}
    </fieldset>
  );
}

export async function Filters({
  action,
  facets,
  state,
}: {
  action: string;
  facets: CatalogResult['facets'];
  state: FilterState;
}) {
  const t = await getTranslations('Catalog');
  const tl = await getTranslations('Languages');
  const tc = await getTranslations('Conditions');
  const tf = await getTranslations('Finishes');
  const tt = await getTranslations('Supertypes');
  const more = (n: number) => t('moreCount', { count: n });
  const conditionOrder = Object.keys(CONDITIONS);
  const conds = [...facets.conditions].sort(
    (a, b) => conditionOrder.indexOf(a.value) - conditionOrder.indexOf(b.value),
  );
  return (
    <details className="filters" id="filters-panel">
      <summary>{t('filters')}</summary>
      <form action={action} method="get" id="filters">
        {state.q && <input type="hidden" name="q" value={state.q} />}
        {state.sort && <input type="hidden" name="sort" value={state.sort} />}
        <Group
          name="cat"
          legend={t('category')}
          facets={facets.categories}
          selected={state.cat}
          label={(f) => f.label}
          moreLabel={more}
        />
        <Group
          name="lang"
          legend={t('language')}
          facets={facets.languages}
          selected={state.lang}
          label={(f) => tl(f.value as never)}
          moreLabel={more}
        />
        <Group
          name="cond"
          legend={t('condition')}
          facets={conds}
          selected={state.cond}
          label={(f) => `${f.value} ${tc(f.value as never)}`}
          moreLabel={more}
        />
        <Group
          name="series"
          legend={t('series')}
          facets={facets.series}
          selected={state.series}
          label={(f) => f.label}
          moreLabel={more}
        />
        <Group
          name="set"
          legend={t('set')}
          facets={facets.sets}
          selected={state.set}
          label={(f) => f.label}
          moreLabel={more}
        />
        <Group
          name="rarity"
          legend={t('rarity')}
          facets={facets.rarities}
          selected={state.rarity}
          label={(f) => f.label}
          moreLabel={more}
        />
        <Group
          name="finish"
          legend={t('finish')}
          facets={facets.finishes}
          selected={state.finish}
          label={(f) => tf(f.value as never)}
          moreLabel={more}
        />
        <Group
          name="type"
          legend={t('supertype')}
          facets={facets.supertypes}
          selected={state.type}
          label={(f) => tt(f.value as never)}
          moreLabel={more}
        />
        <fieldset>
          <legend>{t('price')}</legend>
          <div className="price-range">
            <label className="visually-hidden" htmlFor="min">
              {t('priceFrom')}
            </label>
            <input
              id="min"
              name="min"
              inputMode="decimal"
              placeholder={t('priceFrom')}
              defaultValue={state.min}
            />
            <label className="visually-hidden" htmlFor="max">
              {t('priceTo')}
            </label>
            <input
              id="max"
              name="max"
              inputMode="decimal"
              placeholder={t('priceTo')}
              defaultValue={state.max}
            />
          </div>
        </fieldset>
        <fieldset>
          <label>
            <input type="checkbox" name="graded" value="1" defaultChecked={state.graded} />
            <span>{t('graded')}</span>
          </label>
          <label>
            <input type="checkbox" name="all" value="1" defaultChecked={state.all} />
            <span>{t('includeSoldOut')}</span>
          </label>
        </fieldset>
        <div className="actions">
          <button className="btn" type="submit">
            {t('apply')}
          </button>
          <a
            className="btn btn--quiet"
            href={state.q ? `${action}?q=${encodeURIComponent(state.q)}` : action}
          >
            {t('reset')}
          </a>
        </div>
        <AutoSubmit formId="filters" panelId="filters-panel" />
      </form>
    </details>
  );
}
