import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { requireAccount } from '@/server/account';
import { getCompany } from '@/server/shop';
import { AccountShell } from '@/components/account/AccountShell';
import { deleteAccountAction, saveSettingsAction } from '../../account-actions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ e?: string; saved?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Account' });
  return { title: t('settings.title'), robots: { index: false } };
}

function unpack(s: string | undefined): {
  errors?: Record<string, string>;
  values?: Record<string, string>;
} {
  if (!s) return {};
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

export default async function AccountSettingsPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const account = await requireAccount(
    locale,
    getPathname({ href: '/konto/einstellungen', locale }),
  );
  const t = await getTranslations('Account');
  const q = await searchParams;
  const { errors = {}, values } = unpack(q.e);
  const { email: shopEmail } = await getCompany();
  return (
    <AccountShell account={account} active="settings" title={t('settings.title')} locale={locale}>
      {q.saved && (
        <p className="notice" role="status">
          {t('settings.saved')}
        </p>
      )}
      <form action={saveSettingsAction} className="account-form stack" noValidate>
        <input type="hidden" name="locale" value={locale} />
        <div className="field">
          <span>{t('settings.email')}</span>
          <p className="account-form__static">{account.email}</p>
          <small className="muted">
            {t.rich('settings.emailHint', {
              mail: (c) => <a href={`mailto:${String(shopEmail)}`}>{c}</a>,
            })}
          </small>
        </div>
        <label className={errors.name ? 'field field--error' : 'field'} htmlFor="s-name">
          <span>{t('settings.name')}</span>
          <input
            id="s-name"
            name="name"
            defaultValue={values?.name ?? account.name ?? ''}
            autoComplete="name"
            maxLength={100}
          />
          {errors.name && <small className="field__error">{t('errors.too_long')}</small>}
        </label>
        <label className="field" htmlFor="s-language">
          <span>{t('settings.language')}</span>
          <select id="s-language" name="language" defaultValue={account.locale}>
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
          <small className="muted">{t('settings.languageHint')}</small>
        </label>
        <div className="account-form__actions">
          <button type="submit" className="btn btn--accent">
            {t('settings.save')}
          </button>
        </div>
      </form>

      <section
        className="account-panel account-panel--danger"
        id="delete"
        aria-labelledby="del-title"
      >
        <h2 id="del-title">{t('settings.deleteTitle')}</h2>
        <p>{t('settings.deleteText')}</p>
        <form action={deleteAccountAction} className="stack">
          <input type="hidden" name="locale" value={locale} />
          <label className={errors.confirm ? 'check check--error' : 'check'}>
            <input type="checkbox" name="confirm" /> {t('settings.deleteConfirm')}
          </label>
          {errors.confirm && (
            <small className="field__error">{t('settings.deleteConfirmMissing')}</small>
          )}
          <button type="submit" className="btn btn--danger-outline">
            {t('settings.deleteButton')}
          </button>
        </form>
      </section>
    </AccountShell>
  );
}
