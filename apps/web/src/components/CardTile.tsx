import { getTranslations } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import type { CatalogTile } from '@pokeshop/core/storefront';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { AltNames, namesText } from './AltNames';
import { CardImage } from './CardImage';

export async function CardTile({
  card,
  locale,
  priority = false,
}: {
  card: CatalogTile;
  locale: Locale;
  priority?: boolean;
}) {
  const t = await getTranslations('Card');
  const tf = await getTranslations('Finishes');
  const holo = card.finish !== 'normal';
  return (
    <li className="tile">
      <CardImage
        image={card.image}
        alt={`${namesText(card.name, card.nameTranslations)}, ${card.setName ?? card.setCode} ${card.cardNumber}`}
        priority={priority}
        noImageLabel={t('noImage')}
      />
      <Link
        href={{ pathname: '/karten/[slug]', params: { slug: card.slug } }}
        className="tile__link"
      >
        <span className="tile__name" lang={card.nameLang}>
          {card.name}
        </span>
      </Link>
      <AltNames translations={card.nameTranslations} className="tile__alt" />
      <span className="tile__set">
        {card.setName ?? card.setCode} <span className="num">{card.cardNumber}</span>
      </span>
      <ul className="tags" aria-label={`${t('language')}, ${t('condition')}, ${t('finish')}`}>
        <li className="tag" title={t('language')}>
          {card.cardLanguage}
        </li>
        <li className="tag" title={t('condition')}>
          {card.condition}
        </li>
        <li className={holo ? 'tag tag--holo' : 'tag'}>{tf(card.finish as never)}</li>
        {card.grading && <li className="tag">{card.grading}</li>}
      </ul>
      <div className="tile__foot">
        <span className="price">{formatEuro(card.priceCents, locale)}</span>
        {card.available > 0 ? (
          <span className={card.available === 1 ? 'stock stock--last' : 'stock'}>
            {t('available', { count: card.available })}
          </span>
        ) : (
          <span className="stock muted">{t('soldOut')}</span>
        )}
      </div>
    </li>
  );
}
