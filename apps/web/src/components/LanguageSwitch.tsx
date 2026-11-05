'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';

/** Links to the same page in the other language; product slugs are mapped by the page itself. */
export function LanguageSwitch({ label, title }: { label: string; title: string }) {
  const locale = useLocale();
  const pathname = usePathname();
  const params = useParams();
  const search = useSearchParams();
  const other = locale === 'de' ? 'en' : 'de';
  const query = Object.fromEntries(search.entries());
  const { locale: _ignored, ...routeParams } = params as Record<string, string>;
  return (
    <Link
      className="lang-switch"
      locale={other}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      href={{ pathname, params: routeParams, query } as any}
      hrefLang={other}
      lang={other}
      title={title}
    >
      <span className="long">{label}</span>
      <span className="short" aria-hidden="true">
        {other.toUpperCase()}
      </span>
    </Link>
  );
}
