import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { listCatalog, setInfo } from '@pokeshop/core/storefront';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { CardTile } from '@/components/CardTile';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: Locale; set: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, set } = await params;
  const s = await setInfo(db(), decodeURIComponent(set), locale);
  if (!s) return {};
  return {
    title: `${s.name}${s.series ? ` (${s.series})` : ''}`,
    alternates: {
      canonical: getPathname({
        href: { pathname: '/sets/[set]', params: { set: s.setCode } },
        locale,
      }),
      languages: {
        de: getPathname({
          href: { pathname: '/sets/[set]', params: { set: s.setCode } },
          locale: 'de',
        }),
        en: getPathname({
          href: { pathname: '/sets/[set]', params: { set: s.setCode } },
          locale: 'en',
        }),
      },
    },
  };
}

export default async function SetPage({ params }: Props) {
  const { locale, set } = await params;
  setRequestLocale(locale);
  const s = await setInfo(db(), decodeURIComponent(set), locale);
  if (!s) notFound();
  const t = await getTranslations('Sets');
  const format = await getFormatter();
  const cards = await listCatalog(
    db(),
    { sets: [s.setCode], sort: 'number', pageSize: 120 },
    locale,
  );
  return (
    <div className="wrap">
      <header className="section__head" style={{ paddingTop: 'var(--s-6)', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: 'var(--t-2xl)' }}>{s.name}</h1>
          <p className="muted">
            {[
              s.series,
              s.releaseDate
                ? t('released', {
                    date: format.dateTime(new Date(s.releaseDate), {
                      year: 'numeric',
                      month: 'long',
                    }),
                  })
                : null,
              s.cardCount ? t('cards', { count: s.cardCount }) : null,
            ]
              .filter(Boolean)
              .join('. ')}
          </p>
        </div>
        {s.logo && (
          <img
            src={`/media/card/${s.logo}.webp`}
            alt=""
            width={200}
            height={80}
            style={{ maxHeight: '4.5rem', width: 'auto' }}
          />
        )}
      </header>
      {cards.items.length ? (
        <ul className="card-grid">
          {cards.items.map((c, i) => (
            <CardTile key={c.id} card={c} locale={locale} priority={i < 4} />
          ))}
        </ul>
      ) : (
        <p className="empty">{t('empty')}</p>
      )}
    </div>
  );
}
