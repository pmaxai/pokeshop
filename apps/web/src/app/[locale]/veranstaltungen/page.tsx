import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { pastEvents, upcomingEvents } from '@pokeshop/core/events';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { dateParts, eventPlace, eventTexts, eventWhen } from './format';
import { pageAlternates } from '@/server/seo';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Events' });
  return {
    title: t('title'),
    description: t('intro'),
    alternates: pageAlternates('/veranstaltungen', locale),
  };
}

export default async function EventsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Events');
  const [upcoming, past] = await Promise.all([upcomingEvents(db()), pastEvents(db())]);
  return (
    <div className="wrap events-page">
      <h1>{t('title')}</h1>
      <p className="lead">{t('intro')}</p>
      <h2 className="visually-hidden">{t('upcoming')}</h2>
      {upcoming.length === 0 ? (
        <p className="empty">{t('none')}</p>
      ) : (
        <ol className="event-list">
          {upcoming.map((e) => {
            const d = dateParts(new Date(e.starts_at), locale);
            const { title } = eventTexts(e, locale);
            return (
              <li key={e.id} className="event-row">
                <p className="event-date" aria-hidden="true">
                  <span className="event-date__day">{d.day}</span>
                  <span className="event-date__month">{d.month}</span>
                  <span className="event-date__year">{d.year}</span>
                </p>
                <div className="event-row__body">
                  <h3>
                    <Link href={{ pathname: '/veranstaltungen/[slug]', params: { slug: e.slug } }}>
                      {title}
                    </Link>
                  </h3>
                  <p className="event-row__when">{eventWhen(e, locale, t('until'))}</p>
                  <p className="muted">
                    {eventPlace(e)}
                    {e.entry_fee ? ` · ${t('entry')}: ${e.entry_fee}` : ''}
                    {e.table_info ? ` · ${t('table')}: ${e.table_info}` : ''}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {past.length > 0 && (
        <section className="events-past">
          <h2>{t('past')}</h2>
          <ul>
            {past.map((e) => (
              <li key={e.id}>
                <span className="num">
                  {new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
                    dateStyle: 'medium',
                    timeZone: 'Europe/Vienna',
                  }).format(new Date(e.starts_at))}
                </span>{' '}
                {eventTexts(e, locale).title}, {e.city}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
