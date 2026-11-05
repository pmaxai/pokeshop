import type { ShopEvent } from '@pokeshop/core/events';

const tz = 'Europe/Vienna';

export function eventTexts(e: ShopEvent, locale: 'de' | 'en') {
  return {
    title: (locale === 'en' && e.title_en) || e.title_de,
    description: (locale === 'en' && e.description_en) || e.description_de,
  };
}

/** "Sa., 12. Dezember 2026, 10:00–17:00" or across days "12.–13. Dezember 2026". */
export function eventWhen(e: ShopEvent, locale: 'de' | 'en', until: string): string {
  const loc = locale === 'de' ? 'de-AT' : 'en-GB';
  const day = new Intl.DateTimeFormat(loc, {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: tz,
  });
  const time = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', timeZone: tz });
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  const start = new Date(e.starts_at);
  if (!e.ends_at) return `${day.format(start)}, ${time.format(start)}`;
  const end = new Date(e.ends_at);
  if (dayKey.format(start) === dayKey.format(end))
    return `${day.format(start)}, ${time.format(start)}–${time.format(end)}`;
  return `${day.format(start)}, ${time.format(start)} ${until} ${day.format(end)}, ${time.format(end)}`;
}

export function dateParts(d: Date, locale: 'de' | 'en') {
  const loc = locale === 'de' ? 'de-AT' : 'en-GB';
  return {
    day: new Intl.DateTimeFormat(loc, { day: 'numeric', timeZone: tz }).format(d),
    month: new Intl.DateTimeFormat(loc, { month: 'short', timeZone: tz })
      .format(d)
      .replace('.', ''),
    year: new Intl.DateTimeFormat(loc, { year: 'numeric', timeZone: tz }).format(d),
  };
}

export const eventPlace = (e: ShopEvent) => [e.venue, e.city].filter(Boolean).join(', ');
