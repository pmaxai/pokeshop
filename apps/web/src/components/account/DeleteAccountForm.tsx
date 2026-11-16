import { getTranslations } from 'next-intl/server';
import type { Locale } from '@/i18n/routing';
import { deleteAccountAction } from '@/app/[locale]/account-actions';

/** The delete button with its confirmation tick, on the settings page and the public delete page. */
export async function DeleteAccountForm({
  locale,
  error,
  back,
}: {
  locale: Locale;
  error?: string;
  back: 'settings' | 'delete';
}) {
  const t = await getTranslations('Account');
  return (
    <form action={deleteAccountAction} className="stack">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="back" value={back} />
      <label className={error ? 'check check--error' : 'check'}>
        <input type="checkbox" name="confirm" /> {t('settings.deleteConfirm')}
      </label>
      {error && (
        <small className="field__error">
          {error === 'subscription'
            ? t('settings.deleteSubscription')
            : t('settings.deleteConfirmMissing')}
        </small>
      )}
      <button type="submit" className="btn btn--danger-outline">
        {t('settings.deleteButton')}
      </button>
    </form>
  );
}
