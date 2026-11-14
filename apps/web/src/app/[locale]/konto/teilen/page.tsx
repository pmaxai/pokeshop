import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { listBinders, listShares, shareUrl } from '@pokeshop/core/collection';
import { getPathname, Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { config, db } from '@/server/config';
import { requirePortal } from '@/server/account';
import { AccountShell } from '@/components/account/AccountShell';
import { PortalLocked } from '@/components/account/PortalLocked';
import { createShareAction, revokeShareAction } from '../../collection-actions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ e?: string; created?: string; revoked?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Portal' });
  return { title: t('share.title'), robots: { index: false } };
}

type Flash = { kind?: string; errors?: Record<string, string>; values?: Record<string, unknown> };
function unpack(s: string | undefined): Flash {
  if (!s) return {};
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Flash;
  } catch {
    return {};
  }
}

export default async function SharingPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const q = await searchParams;
  const here = getPathname({ href: '/konto/teilen', locale });
  const { account, portal } = await requirePortal(locale, here);
  const t = await getTranslations('Portal');
  if (!portal) {
    return (
      <AccountShell account={account} active="collection" title={t('share.title')} locale={locale}>
        <PortalLocked />
      </AccountShell>
    );
  }
  const [binders, shares] = await Promise.all([
    listBinders(db(), account.id),
    listShares(db(), account.id),
  ]);
  const flash = unpack(q.e);
  const when = (d: Date) =>
    new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Europe/Vienna',
    }).format(d);
  const scope = (ids: number[]) =>
    ids.length === 0
      ? t('share.whole')
      : ids.map((id) => binders.find((b) => b.id === id)?.name ?? '?').join(', ');
  const errorFor = (kind: string, k: string) =>
    flash.kind === kind && flash.errors?.[k] ? (
      <small className="field__error">{t(`share.errors.${flash.errors[k]}` as never)}</small>
    ) : null;

  const binderBoxes = (kind: string) =>
    binders.length > 0 && (
      <fieldset className="share-binders">
        <legend>{t('share.what')}</legend>
        <p className="muted small">{t('share.whatHint')}</p>
        {binders.map((b) => (
          <label key={b.id} className="check">
            <input type="checkbox" name="binders" value={b.id} /> {b.name}{' '}
            <span className="muted small">({b.cards})</span>
          </label>
        ))}
        {errorFor(kind, 'binderIds')}
      </fieldset>
    );

  return (
    <AccountShell account={account} active="collection" title={t('share.title')} locale={locale}>
      <p className="small">
        <Link href="/konto/sammlung">← {t('share.back')}</Link>
      </p>
      {q.created && (
        <p className="notice" role="status">
          {t('share.created')}
        </p>
      )}
      {q.revoked && (
        <p className="notice" role="status">
          {t('share.revoked')}
        </p>
      )}

      <section className="account-panel" aria-labelledby="sh-list">
        <h2 id="sh-list">{t('share.active')}</h2>
        {shares.length === 0 ? (
          <p className="muted">{t('share.none')}</p>
        ) : (
          <ul className="share-list">
            {shares.map((s) => {
              const expired = s.expiresAt !== null && s.expiresAt <= new Date();
              return (
                <li key={s.id} className={q.created === String(s.id) ? 'is-saved' : undefined}>
                  <div>
                    <strong>
                      {s.kind === 'public'
                        ? t('share.publicLink')
                        : t('share.forPerson', { email: s.recipientEmail ?? '' })}
                    </strong>
                    {s.title && <> · {s.title}</>}
                    <div className="muted small">
                      {scope(s.binderIds)} ·{' '}
                      {s.showPrices ? t('share.withPrices') : t('share.withoutPrices')} ·{' '}
                      {s.expiresAt
                        ? expired
                          ? t('share.expired', { date: when(s.expiresAt) })
                          : t('share.until', { date: when(s.expiresAt) })
                        : t('share.noEnd')}{' '}
                      · {t('share.views', { count: s.views })}
                    </div>
                    {s.kind === 'public' && !expired && (
                      <input
                        className="share-link"
                        readOnly
                        value={shareUrl(config.baseUrl, s.token, locale)}
                        aria-label={t('share.linkLabel')}
                      />
                    )}
                  </div>
                  <form action={revokeShareAction}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="id" value={s.id} />
                    <button className="btn btn--small btn--quiet" type="submit">
                      {expired ? t('share.remove') : t('share.revoke')}
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="account-panel" id="personal" aria-labelledby="sh-personal">
        <h2 id="sh-personal">{t('share.personalTitle')}</h2>
        <p className="muted small">{t('share.personalText')}</p>
        <form action={createShareAction} className="stack">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="kind" value="personal" />
          <label
            className={
              flash.kind === 'personal' && flash.errors?.recipientEmail
                ? 'field field--error'
                : 'field'
            }
            htmlFor="sh-email"
          >
            <span>{t('share.email')}</span>
            <input
              id="sh-email"
              name="email"
              type="email"
              required
              maxLength={200}
              defaultValue={
                flash.kind === 'personal' ? String(flash.values?.recipientEmail ?? '') : ''
              }
            />
            {errorFor('personal', 'recipientEmail')}
          </label>
          <label className="field" htmlFor="sh-msg">
            <span>{t('share.message')}</span>
            <textarea
              id="sh-msg"
              name="message"
              rows={3}
              maxLength={500}
              defaultValue={flash.kind === 'personal' ? String(flash.values?.message ?? '') : ''}
            />
          </label>
          {binderBoxes('personal')}
          <label className="check">
            <input type="checkbox" name="show_prices" defaultChecked /> {t('share.showPrices')}
          </label>
          <button className="btn btn--accent" type="submit">
            {t('share.send')}
          </button>
        </form>
      </section>

      <section className="account-panel" id="public" aria-labelledby="sh-public">
        <h2 id="sh-public">{t('share.publicTitle')}</h2>
        <p className="muted small">{t('share.publicText')}</p>
        <form action={createShareAction} className="stack">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="kind" value="public" />
          <label className="field" htmlFor="sh-title">
            <span>{t('share.titleLabel')}</span>
            <input
              id="sh-title"
              name="title"
              maxLength={80}
              placeholder={t('share.titlePlaceholder')}
            />
          </label>
          {binderBoxes('public')}
          <label className="check">
            <input type="checkbox" name="show_prices" defaultChecked /> {t('share.showPrices')}
          </label>
          <button className="btn" type="submit">
            {t('share.createLink')}
          </button>
        </form>
      </section>
    </AccountShell>
  );
}
