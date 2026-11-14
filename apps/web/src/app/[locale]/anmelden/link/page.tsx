import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { peekLoginLink } from '@pokeshop/core/accounts';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { loginConfirmAction } from '../../account-actions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ t?: string; e?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Account' });
  return { title: t('login.title'), robots: { index: false }, referrer: 'no-referrer' };
}

/**
 * The link from the e-mail. Opening it does not log in yet: mail programs and virus scanners
 * open links on their own, so the customer confirms with a button (a POST).
 */
export default async function LoginLinkPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Account');
  const q = await searchParams;
  const token = q.t ?? '';
  const peek = await peekLoginLink(db(), token);
  const problem = !peek.ok
    ? peek.problem
    : (['invalid', 'expired', 'used'] as const).find((p) => p === q.e);
  return (
    <div className="wrap login-page">
      <div className="login-card">
        <h1>{t('login.title')}</h1>
        {problem || !peek.ok ? (
          <>
            <p className="notice notice--warn" role="alert">
              {t(`link.${problem ?? 'invalid'}`)}
            </p>
            <p>
              <Link href="/anmelden" className="btn btn--accent">
                {t('link.newLink')}
              </Link>
            </p>
          </>
        ) : (
          <form action={loginConfirmAction} className="stack">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="t" value={token} />
            <p className="lead">
              {t.rich('link.confirm', { email: peek.email, b: (c) => <strong>{c}</strong> })}
            </p>
            <button type="submit" className="btn btn--accent" autoFocus>
              {t('link.button')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
