import { getPathname } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';

export async function SearchForm({
  query,
  label,
  placeholder,
  button,
  className = 'search',
}: {
  query?: string | undefined;
  label: string;
  placeholder: string;
  button: string;
  className?: string;
}) {
  const locale = await getLocale();
  const action = getPathname({ href: '/karten', locale: locale as 'de' | 'en' });
  return (
    <form role="search" action={action} method="get" className={className}>
      <label className="visually-hidden" htmlFor={`${className}-q`}>
        {label}
      </label>
      <input
        id={`${className}-q`}
        type="search"
        name="q"
        defaultValue={query}
        placeholder={placeholder}
        autoComplete="off"
        enterKeyHint="search"
      />
      <button className="btn" type="submit">
        {button}
      </button>
    </form>
  );
}
