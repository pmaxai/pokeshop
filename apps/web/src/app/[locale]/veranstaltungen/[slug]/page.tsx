import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { eventBySlug } from '@pokeshop/core/events';
import { Link, getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { config, db } from '@/server/config';
import { dateParts, eventPlace, eventTexts, eventWhen } from '../format';
import { langAlternates } from '@/server/seo';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: Locale; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const e = await eventBySlug(db(), slug);
  if (!e) return {};
  const t = await getTranslations({ locale, namespace: 'Events' });
  const { title, description } = eventTexts(e, locale);
  const path = (l: Locale) =>
    getPathname({ href: { pathname: '/veranstaltungen/[slug]', params: { slug } }, locale: l });
  return {
    title: `${title} – ${eventPlace(e)}`,
    description: `${eventWhen(e, locale, t('until'))}, ${eventPlace(e)}. ${description?.slice(0, 140) ?? ''}`,
    alternates: langAlternates({ en: path('en'), de: path('de') }, locale),
  };
}

export default async function EventPage({ params }: Props) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const e = await eventBySlug(db(), slug);
  if (!e) notFound();
  const t = await getTranslations('Events');
  const { title, description } = eventTexts(e, locale);
  const d = dateParts(new Date(e.starts_at), locale);
  const names = new Intl.DisplayNames([locale === 'de' ? 'de-AT' : 'en'], { type: 'region' });
  const address = [
    e.venue,
    e.street,
    [e.postcode, e.city].filter(Boolean).join(' '),
    names.of(e.country),
  ].filter(Boolean);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: title,
    startDate: new Date(e.starts_at).toISOString(),
    endDate: e.ends_at ? new Date(e.ends_at).toISOString() : undefined,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    description: description ?? undefined,
    url: `${config.baseUrl}${getPathname({ href: { pathname: '/veranstaltungen/[slug]', params: { slug } }, locale })}`,
    location: {
      '@type': 'Place',
      name: e.venue ?? e.city,
      address: {
        '@type': 'PostalAddress',
        streetAddress: e.street ?? undefined,
        postalCode: e.postcode ?? undefined,
        addressLocality: e.city,
        addressCountry: e.country,
      },
    },
    organizer: e.website_url
      ? { '@type': 'Organization', name: title, url: e.website_url }
      : undefined,
  };
  return (
    <article className="wrap event-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/veranstaltungen">{t('all')}</Link>
      </nav>
      <div className="event-head">
        <p className="event-date event-date--large" aria-hidden="true">
          <span className="event-date__day">{d.day}</span>
          <span className="event-date__month">{d.month}</span>
          <span className="event-date__year">{d.year}</span>
        </p>
        <h1>{title}</h1>
      </div>
      <dl className="facts">
        <dt>{t('when')}</dt>
        <dd>{eventWhen(e, locale, t('until'))}</dd>
        <dt>{t('where')}</dt>
        <dd>
          {address.map((l, i) => (
            <span key={i}>
              {l}
              <br />
            </span>
          ))}
        </dd>
        {e.entry_fee && (
          <>
            <dt>{t('entry')}</dt>
            <dd>{e.entry_fee}</dd>
          </>
        )}
        {e.table_info && (
          <>
            <dt>{t('table')}</dt>
            <dd>{e.table_info}</dd>
          </>
        )}
      </dl>
      {description && <div className="description event-text">{description}</div>}
      {e.website_url && (
        <p style={{ marginTop: 'var(--s-5)' }}>
          <a
            href={e.website_url}
            className="btn btn--quiet"
            rel="noopener nofollow"
            target="_blank"
          >
            {t('website')}
          </a>
        </p>
      )}
    </article>
  );
}
