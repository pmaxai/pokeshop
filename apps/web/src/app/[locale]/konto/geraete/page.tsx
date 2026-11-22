import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatCode, listDevices, pairUrl, qrSvg } from '@pokeshop/core/devices';
import { appStores } from '@pokeshop/core/app';
import { accountEntitlements } from '@pokeshop/core/subscriptions';
import { getPathname, Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { config, db } from '@/server/config';
import { PAIR_COOKIE, requireAccount } from '@/server/account';
import { AccountShell } from '@/components/account/AccountShell';
import { connectDeviceAction, removeDeviceAction } from '../../account-actions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ connect?: string; e?: string; removed?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Devices' });
  return { title: t('title'), robots: { index: false } };
}

export default async function DevicesPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const account = await requireAccount(locale, getPathname({ href: '/konto/geraete', locale }));
  const t = await getTranslations('Devices');
  const q = await searchParams;
  const [ent, devices, stores] = await Promise.all([
    accountEntitlements(db(), account),
    listDevices(db(), account.id),
    appStores(db()),
  ]);
  const when = (d: Date) =>
    new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Europe/Vienna',
    }).format(d);
  const time = (d: Date) =>
    new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
      timeStyle: 'short',
      timeZone: 'Europe/Vienna',
    }).format(d);

  // The code made by "Connect a device" (short-lived cookie).
  let pairing: { code: string; url: string; expires: Date; svg: string } | null = null;
  const raw = q.connect ? (await cookies()).get(PAIR_COOKIE)?.value : undefined;
  const m = raw ? /^([0-9A-Z]{12})\.(\d+)$/.exec(raw) : null;
  if (m && Number(m[2]) > Date.now()) {
    const url = pairUrl(config.baseUrl, m[1]!);
    pairing = {
      code: formatCode(m[1]!),
      url,
      expires: new Date(Number(m[2])),
      svg: await qrSvg(url),
    };
  }
  const full = ent.active && devices.length >= ent.seats;

  return (
    <AccountShell account={account} active="devices" title={t('title')} locale={locale}>
      {q.removed && (
        <p className="notice" role="status">
          {t('removed')}
        </p>
      )}
      <section className="account-panel" aria-labelledby="dev-app">
        <h2 id="dev-app">{t('appTitle')}</h2>
        <p>{stores.apple ? t('appText') : t('appTextSoon')}</p>
        {(stores.play || stores.apple) && (
          <p className="account-panel__actions">
            {stores.play && (
              <a className="btn" href={stores.play} rel="noopener noreferrer">
                {t('playStore')}
              </a>
            )}
            {stores.apple && (
              <a className="btn" href={stores.apple} rel="noopener noreferrer">
                {t('appStore')}
              </a>
            )}
          </p>
        )}
        <p className="small muted">
          {ent.active ? (
            t('signIn', { email: account.email })
          ) : (
            <>
              {t('freeHint')} <Link href="/konto/abo">{t('toSubscription')}</Link>
            </>
          )}
        </p>
      </section>

      <section className="account-panel" id="connect" aria-labelledby="dev-connect">
        <h2 id="dev-connect">{t('connectTitle')}</h2>
        {q.e === 'device_limit' && (
          <p className="notice notice--warn" role="alert">
            {t('full', { seats: ent.seats })}
          </p>
        )}
        {!ent.active ? (
          <p className="muted">{t('needsSubscription')}</p>
        ) : pairing ? (
          <div className="pair">
            <div
              className="pair__qr"
              dangerouslySetInnerHTML={{ __html: pairing.svg }}
              role="img"
              aria-label={t('qrLabel')}
            />
            <div className="pair__how">
              <ol>
                <li>{t('step1')}</li>
                <li>{t('step2')}</li>
                <li>{t('step3')}</li>
              </ol>
              <p>
                {t('typed')} <strong className="pair__code num">{pairing.code}</strong>
              </p>
              <p className="small muted">{t('validUntil', { time: time(pairing.expires) })}</p>
              <form action={connectDeviceAction}>
                <input type="hidden" name="locale" value={locale} />
                <button type="submit" className="btn btn--quiet">
                  {t('newCode')}
                </button>
              </form>
            </div>
          </div>
        ) : full ? (
          <p>
            {t('full', { seats: ent.seats })} <Link href="/konto/abo">{t('addDevice')}</Link>
          </p>
        ) : (
          <>
            <p>{t('connectText', { free: ent.seats - devices.length, seats: ent.seats })}</p>
            <form action={connectDeviceAction}>
              <input type="hidden" name="locale" value={locale} />
              <button type="submit" className="btn btn--accent">
                {t('connect')}
              </button>
            </form>
          </>
        )}
      </section>

      <section className="account-panel" aria-labelledby="dev-list">
        <h2 id="dev-list">{t('listTitle', { count: devices.length, seats: ent.seats })}</h2>
        {devices.length === 0 ? (
          <p className="muted">{t('none')}</p>
        ) : (
          <ul className="device-list">
            {devices.map((d) => (
              <li key={d.publicId}>
                <div>
                  <strong>{d.name ?? t('unnamed')}</strong>
                  <span className="muted small">
                    {[
                      d.appVersion ? t('version', { version: d.appVersion }) : null,
                      t('since', { date: when(d.pairedAt) }),
                      d.lastSeenAt ? t('lastSeen', { date: when(d.lastSeenAt) }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <details className="device-list__remove">
                  <summary>{t('remove')}</summary>
                  <p className="small">{t('removeText')}</p>
                  <form action={removeDeviceAction}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="device" value={d.publicId} />
                    <button type="submit" className="btn btn--danger-outline btn--small">
                      {t('removeConfirm')}
                    </button>
                  </form>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AccountShell>
  );
}
