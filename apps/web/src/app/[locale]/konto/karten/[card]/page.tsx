import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import { itemsOfCard, listBinders } from '@pokeshop/core/collection';
import { cardHistory, historyLine, packCard } from '@pokeshop/core/pack-cards';
import { getPathname, Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { requirePortal } from '@/server/account';
import { AccountShell } from '@/components/account/AccountShell';
import { PortalLocked } from '@/components/account/PortalLocked';
import { ItemFields } from '@/components/account/ItemFields';
import { PriceChart } from '@/components/account/PriceChart';
import { addToCollectionAction } from '../../../collection-actions';
import { addWantedAction, removeWantedAction } from '../../../wanted-actions';
import { wantedOfCard } from '@pokeshop/core/wanted';
import { WantedFields, WishTags } from '@/components/account/Wanted';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale; card: string }>;
  searchParams: Promise<{
    p?: string;
    added?: string;
    e?: string;
    wanted?: string;
    removed?: string;
    we?: string;
  }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, card } = await params;
  const c = await packCard(db(), decodeURIComponent(card), [locale, 'en']);
  return { title: c ? `${c.name} ${c.number}` : 'Card', robots: { index: false } };
}

const PACK_TO_SHOP: Record<string, string> = {
  de: 'DE',
  en: 'EN',
  ja: 'JA',
  'zh-tw': 'ZH-HANT',
  'zh-cn': 'ZH-HANS',
};

function unpack(s: string | undefined): Record<string, string> {
  if (!s) return {};
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export default async function CardPage({ params, searchParams }: Props) {
  const { locale, card: raw } = await params;
  setRequestLocale(locale);
  const cardId = decodeURIComponent(raw);
  const q = await searchParams;
  const here = getPathname({
    href: { pathname: '/konto/karten/[card]', params: { card: cardId } },
    locale,
  });
  const { account, portal } = await requirePortal(locale, here);
  const t = await getTranslations('Portal');
  const tf = await getTranslations('Finishes');
  const tl = await getTranslations('Languages');
  if (!portal) {
    return (
      <AccountShell account={account} active="cards" title={t('search.title')} locale={locale}>
        <PortalLocked />
      </AccountShell>
    );
  }
  const card = await packCard(db(), cardId, [locale, 'en']);
  if (!card) notFound();
  const [history, mine, binders, wanted] = await Promise.all([
    cardHistory(db(), card.id),
    itemsOfCard(db(), account.id, card.id, locale),
    listBinders(db(), account.id),
    wantedOfCard(db(), account.id, card.id, locale),
  ]);
  const wantedErrors = unpack(q.we);
  const selected = card.printings.find((p) => p.finish === q.p) ?? card.printings[0];
  const hasNormal = card.printings.some((p) => p.kind === 'normal');
  const line = history && selected ? historyLine(history, selected.kind, hasNormal) : null;
  const eur = (v: number | null) => (v === null ? '–' : formatEuro(Math.round(v * 100), locale));
  const usd = (v: number | null) =>
    v === null
      ? '–'
      : new Intl.NumberFormat(locale === 'de' ? 'de-AT' : 'en-US', {
          style: 'currency',
          currency: 'USD',
        }).format(v);
  const errors = unpack(q.e);
  const otherNames = Object.entries(card.names).filter(
    ([l, n]) => l !== card.lang && n !== card.name,
  );
  const graded = Object.entries(card.graded).filter(([, g]) => g.psa10 || g.psa9 || g.psa8);
  const gradedLabel = (k: string) =>
    k === 'normal'
      ? tf('normal')
      : k === 'holo'
        ? tf('holo')
        : k === 'reverse'
          ? tf('reverse_holo')
          : k === '1st'
            ? tf('first_edition')
            : t('card.anyPrinting');

  return (
    <AccountShell account={account} active="cards" title={card.name} locale={locale}>
      <p className="small">
        <Link href="/konto/karten">← {t('card.back')}</Link>
      </p>
      <div className="card-detail">
        <div className="card-detail__img">
          {card.image ? (
            <img
              src={card.image.large}
              alt={`${card.name} ${card.number}`}
              width={600}
              height={825}
            />
          ) : (
            <div className="pack-tile__none" />
          )}
        </div>
        <div className="card-detail__info">
          <p className="card-detail__meta">
            {card.setName} · <span className="num">{card.number}</span>
            {card.releaseDate && <> · {card.releaseDate.slice(0, 4)}</>}
            {card.rarity && <> · {card.rarity}</>}
          </p>
          {otherNames.length > 0 && (
            <p className="muted small">
              {otherNames.map(([l, n]) => `${n} (${l.toUpperCase()})`).join(' · ')}
            </p>
          )}
          {card.priceCheck && (
            <p className="notice notice--warn">{t(`card.check.${card.priceCheck.status}`)}</p>
          )}
          <div className="table-scroll">
            <table className="price-table">
              <caption className="visually-hidden">{t('card.pricesCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('card.printing')}</th>
                  <th scope="col">{t('card.trend')}</th>
                  <th scope="col">{t('card.avg30')}</th>
                  <th scope="col">{t('card.low')}</th>
                  <th scope="col">TCGplayer</th>
                </tr>
              </thead>
              <tbody>
                {card.printings.map((p) => (
                  <tr key={p.kind} aria-current={p === selected ? 'true' : undefined}>
                    <th scope="row">
                      <Link
                        href={{
                          pathname: '/konto/karten/[card]',
                          params: { card: card.id },
                          query: { p: p.finish },
                        }}
                        scroll={false}
                      >
                        {tf(p.finish as never)}
                      </Link>
                    </th>
                    <td className="num">{eur(p.eur)}</td>
                    <td className="num">{eur(p.eur30)}</td>
                    <td className="num">{eur(p.eurLow)}</td>
                    <td className="num">
                      {usd(p.usd)}
                      {p.usdEur !== null && <span className="muted small"> ≈ {eur(p.usdEur)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {line && history && selected && (
            <PriceChart
              dates={history.dates}
              values={line.values}
              locale={locale}
              label={t('card.history', {
                printing: tf(selected.finish as never),
                source: line.source === 'cardmarket' ? 'Cardmarket' : 'TCGplayer',
              })}
            />
          )}
          {graded.length > 0 && (
            <div className="table-scroll">
              <table className="price-table">
                <caption className="price-table__caption">{t('card.psa')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('card.printing')}</th>
                    <th scope="col">PSA 10</th>
                    <th scope="col">PSA 9</th>
                    <th scope="col">PSA 8</th>
                  </tr>
                </thead>
                <tbody>
                  {graded.map(([k, g]) => (
                    <tr key={k}>
                      <th scope="row">{gradedLabel(k)}</th>
                      {(
                        [
                          ['psa10', 'psa10n'],
                          ['psa9', 'psa9n'],
                          ['psa8', 'psa8n'],
                        ] as const
                      ).map(([v, n]) => (
                        <td key={v} className="num">
                          {usd(g[v])}
                          {g[n] ? <span className="muted small"> ({g[n]})</span> : null}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted">
            {t('card.source', { date: card.pricesUpdated?.slice(0, 10) ?? '–' })}
          </p>
        </div>
      </div>

      {mine.length > 0 && (
        <section className="account-panel" aria-labelledby="mine-title">
          <h2 id="mine-title">
            {t('card.mine', { count: mine.reduce((a, i) => a + i.quantity, 0) })}
          </h2>
          <ul className="mini-lines">
            {mine.map((i) => (
              <li key={i.id}>
                <Link href={{ pathname: '/konto/sammlung/[id]', params: { id: String(i.id) } }}>
                  {i.quantity} × {tl(i.language as never)} · {tf(i.finish as never)} · {i.condition}
                  {i.grading ? ` · ${i.grading.company} ${i.grading.grade}` : ''}
                </Link>
                <span className="num">
                  {i.valueCents !== null
                    ? formatEuro(i.valueCents * i.quantity, locale)
                    : t('noPrice')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="account-panel" id="add" aria-labelledby="add-title">
        <h2 id="add-title">{t('card.addTitle')}</h2>
        {q.added && (
          <p className="notice" role="status">
            {t('card.added')} <Link href="/konto/sammlung">{t('card.toCollection')}</Link>
          </p>
        )}
        {Object.keys(errors).length > 0 && (
          <p className="notice notice--warn" role="alert">
            {t('errorsTitle')}
          </p>
        )}
        <form action={addToCollectionAction} className="stack">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="card_id" value={card.id} />
          <input type="hidden" name="back" value={here} />
          <ItemFields
            idPrefix="add"
            values={{
              language: PACK_TO_SHOP[card.lang] ?? 'EN',
              finish: selected?.finish,
              condition: 'NM',
            }}
            finishes={card.printings.map((p) => p.finish)}
            binders={binders}
            errors={errors}
          />
          <button type="submit" className="btn btn--accent">
            {t('card.add')}
          </button>
        </form>
      </section>

      <section className="account-panel wanted-card" id="wanted" aria-labelledby="wanted-title">
        <h2 id="wanted-title">{t('wanted.cardTitle')}</h2>
        {q.wanted && (
          <p className="notice" role="status">
            {t('wanted.added')} <Link href="/konto/fehlend">{t('wanted.toList')}</Link>
          </p>
        )}
        {q.removed && (
          <p className="notice" role="status">
            {t('wanted.removed')}
          </p>
        )}
        {wanted.length > 0 ? (
          <ul className="mini-lines">
            {wanted.map((w) => (
              <li key={w.id}>
                <span>
                  <WishTags w={w} locale={locale} />{' '}
                  <span className={`wanted-state wanted-state--${w.state}`}>
                    {t(`wanted.state.${w.state}`)}
                  </span>
                </span>
                <form action={removeWantedAction}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="id" value={w.id} />
                  <input type="hidden" name="back" value={here} />
                  <button type="submit" className="link-button small">
                    {t('wanted.remove')}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <form action={addWantedAction} className="stack">
            <p className="muted small">{t('wanted.cardText')}</p>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="card_id" value={card.id} />
            <input type="hidden" name="back" value={here} />
            <details className="wanted-wishes" open={Object.keys(wantedErrors).length > 0}>
              <summary>{t('wanted.wishes')}</summary>
              <WantedFields finishes={card.printings.map((p) => p.finish)} errors={wantedErrors} />
            </details>
            <button type="submit" className="btn btn--quiet">
              ☆ {t('wanted.mark')}
            </button>
          </form>
        )}
      </section>
    </AccountShell>
  );
}
