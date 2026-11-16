import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { licenseSeller } from '@pokeshop/core/licenses';
import { getPathname, Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { currentAccount, loginPath } from '@/server/account';
import { pageAlternates } from '@/server/seo';
import { DeleteAccountForm } from '@/components/account/DeleteAccountForm';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ e?: string; done?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'DeleteAccount' });
  return { title: t('title'), alternates: pageAlternates('/konto-loeschen', locale) };
}

function confirmError(s: string | undefined): string | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))?.errors?.confirm;
  } catch {
    return undefined;
  }
}

/**
 * How to delete an account. Google Play requires a public page for it (its URL goes into the
 * Play Console's Data safety form). Signed-in visitors can delete right here; everyone else
 * deletes in the app or writes from the account's address.
 */
export default async function DeleteAccountPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { e, done } = await searchParams;
  const t = await getTranslations('DeleteAccount');
  const [account, seller] = await Promise.all([currentAccount(), licenseSeller(db())]);
  const login = loginPath(locale, getPathname({ href: '/konto-loeschen', locale }));
  const mail = (
    <a href={`mailto:${seller.email}?subject=${encodeURIComponent(t('mailSubject'))}`}>
      {seller.email}
    </a>
  );
  return (
    <article className="wrap prose legal">
      <h1>{t('title')}</h1>
      {done && !account && (
        <p className="notice" role="status">
          {t('done')}
        </p>
      )}
      <p>{t('intro')}</p>

      <h2>{t('howTitle')}</h2>
      <ul>
        <li>{t('inApp')}</li>
        <li>
          {t.rich('online', {
            link: (c) => <a href={account ? '#delete' : login}>{c}</a>,
          })}
        </li>
        <li>{t.rich('byMail', { mail: () => mail })}</li>
      </ul>

      {account && (
        <section className="account-panel account-panel--danger" id="delete">
          <h2>{t('signedInTitle')}</h2>
          <p>{t('signedInText', { email: account.email })}</p>
          <DeleteAccountForm locale={locale} error={confirmError(e)} back="delete" />
        </section>
      )}

      <h2>{t('whatTitle')}</h2>
      <ul>
        <li>{t('whatGone')}</li>
        <li>{t('whatDevices')}</li>
        <li>{t('whatKept')}</li>
        <li>{t('whatWhen')}</li>
      </ul>

      <h2>{t('subTitle')}</h2>
      <p>{t('subText')}</p>
      <p>
        {t.rich('privacy', {
          link: (c) => <Link href="/app/datenschutz">{c}</Link>,
        })}
      </p>
    </article>
  );
}
