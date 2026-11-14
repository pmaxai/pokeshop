import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { safeNextPath } from '@pokeshop/core/accounts';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { currentAccount, LOGIN_SENT_COOKIE } from '@/server/account';
import { pageAlternates } from '@/server/seo';
import { loginRequestAction } from '../account-actions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ next?: string; sent?: string; e?: string; email?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Account' });
  return {
    title: t('login.title'),
    robots: { index: false },
    alternates: pageAlternates('/anmelden', locale),
  };
}

const ERRORS = ['invalid_email', 'too_long', 'too_many'] as const;

export default async function LoginPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Account');
  const q = await searchParams;
  const next = safeNextPath(q.next);
  if (await currentAccount()) redirect(next ?? getPathname({ href: '/konto', locale }));
  const sentTo = q.sent ? (await cookies()).get(LOGIN_SENT_COOKIE)?.value : undefined;
  const error = ERRORS.find((e) => e === q.e);

  if (q.sent) {
    return (
      <div className="wrap login-page">
        <div className="login-card" role="status">
          <h1>{t('login.sentTitle')}</h1>
          <p className="lead">
            {sentTo
              ? t.rich('login.sentText', { email: sentTo, b: (c) => <strong>{c}</strong> })
              : t('login.sentTextNoEmail')}
          </p>
          <p className="muted">{t('login.sentHint')}</p>
          <p>
            <a
              href={`${getPathname({ href: '/anmelden', locale })}${next ? `?next=${encodeURIComponent(next)}` : ''}`}
            >
              {t('login.again')}
            </a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap login-page">
      <div className="login-card">
        <h1>{t('login.title')}</h1>
        <p className="lead">{t('login.intro')}</p>
        <form action={loginRequestAction} className="stack" noValidate>
          <input type="hidden" name="locale" value={locale} />
          {next && <input type="hidden" name="next" value={next} />}
          <label
            className={error && error !== 'too_many' ? 'field field--error' : 'field'}
            htmlFor="l-email"
          >
            <span>{t('login.email')}</span>
            <input
              id="l-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              defaultValue={q.email ?? ''}
              aria-invalid={error && error !== 'too_many' ? true : undefined}
              aria-describedby={error ? 'l-email-err' : undefined}
            />
            {error && (
              <small id="l-email-err" className="field__error">
                {t(`login.errors.${error}`)}
              </small>
            )}
          </label>
          <div className="contact-hp" aria-hidden="true">
            <label htmlFor="l-website">Website</label>
            <input id="l-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
          </div>
          <button type="submit" className="btn btn--accent">
            {t('login.submit')}
          </button>
        </form>
        <p className="muted small login-card__note">{t('login.note')}</p>
      </div>
    </div>
  );
}
