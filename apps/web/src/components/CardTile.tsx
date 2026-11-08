import { getTranslations } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import type { CatalogTile } from '@pokeshop/core/storefront';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { cartQuantities } from '@/server/cart';
import { AltNames, namesText } from './AltNames';
import { CardImage } from './CardImage';
import { QuickAdd } from './QuickAdd';

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
  const tc = await getTranslations('Conditions');
  const holo = card.finish !== 'normal';
  const cart = await cartQuantities();
  const label = namesText(card.name, card.nameTranslations);
  // several conditions of this card: the picker at the foot shows them instead of a tag
  const many = card.variants.length > 1;
  return (
    <li className="tile">
      <CardImage
        image={card.image}
        alt={`${label}, ${card.setName ?? card.setCode} ${card.cardNumber}`}
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
      <ul
        className="tags"
        aria-label={
          many
            ? `${t('language')}, ${t('finish')}`
            : `${t('language')}, ${t('condition')}, ${t('finish')}`
        }
      >
        <li className="tag" title={t('language')}>
          {card.cardLanguage}
        </li>
        {!many && (
          <li className="tag" title={t('condition')}>
            {card.condition}
          </li>
        )}
        <li className={holo ? 'tag tag--holo' : 'tag'}>{tf(card.finish as never)}</li>
        {card.grading && <li className="tag">{card.grading}</li>}
      </ul>
      {card.available > 0 ? (
        <QuickAdd
          leadId={card.id}
          locale={locale}
          cardLabel={label}
          variants={card.variants.map((v) => ({
            id: v.id,
            condition: v.condition,
            conditionName: tc(v.condition as never),
            priceCents: v.priceCents,
            available: v.available,
            inCart: cart.get(v.id) ?? 0,
          }))}
        />
      ) : (
        <div className="tile__foot">
          <span className="price">{formatEuro(card.priceCents, locale)}</span>
          <span className="stock muted">{t('soldOut')}</span>
        </div>
      )}
    </li>
  );
}
