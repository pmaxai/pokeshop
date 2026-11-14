import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import { licenseSeller } from '@pokeshop/core/licenses';
import {
  accountServices,
  entitlements,
  MAX_EXTRA_DEVICES,
  monthlyCents,
  netPrice,
  subscriptionOf,
  subscriptionPrices,
  syncStripeSubscription,
} from '@pokeshop/core/subscriptions';
import { getPathname, Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { requireAccount } from '@/server/account';
import { billing } from '@/server/billing';
import { AccountShell } from '@/components/account/AccountShell';
import { SubscribeForm, type PlanPrices } from '@/components/account/SubscribeForm';
import {
  billingPortalAction,
  cancelSubscriptionAction,
  changeSubscriptionAction,
  subscribeAction,
} from '../../account-actions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<Record<string, string | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Subscription' });
  return { title: t('title'), robots: { index: false } };
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

const CHANGE_MESSAGES = [
  'done',
  'devices_in_use',
  'unchanged',
  'payment_failed',
  'failed',
  'invalid',
] as const;

export default async function SubscriptionPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const account = await requireAccount(locale, getPathname({ href: '/konto/abo', locale }));
  const t = await getTranslations('Subscription');
  const q = await searchParams;
  const b = billing();
  // Back from Stripe before its webhook arrived: ask Stripe directly.
  if (q.session_id && b && /^[A-Za-z0-9_]{8,200}$/.test(q.session_id)) {
    try {
      const subId = await b.checkoutSubscription(q.session_id);
      if (subId) await syncStripeSubscription(db(), b, subId);
    } catch (e) {
      console.error('[subscription] sync after checkout:', (e as Error).message);
    }
  }
  const [sub, services, prices, seller] = await Promise.all([
    subscriptionOf(db(), account.id),
    accountServices(db(), account.id),
    subscriptionPrices(db()),
    licenseSeller(db()),
  ]);
  const ent = entitlements(sub, account, new Date(), services);
  const eur = (c: number) => formatEuro(c, locale);
  const date = (d: Date) =>
    new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
      dateStyle: 'long',
      timeZone: 'Europe/Vienna',
    }).format(d);

  if (ent.active && sub) {
    const behavior = sub.taxBehavior ?? 'incl';
    const monthly = monthlyCents(prices, sub.plan, sub.extraDevices, behavior);
    const change = CHANGE_MESSAGES.find((c) => c === q.change);
    const stripe = sub.source === 'stripe';
    return (
      <AccountShell account={account} active="subscription" title={t('title')} locale={locale}>
        {q.welcome && (
          <p className="notice" role="status">
            {t('welcome')} <Link href="/konto/geraete">{t('welcomeNext')}</Link>
          </p>
        )}
        {q.cancelled_sub && (
          <p className="notice" role="status">
            {t('cancelledNotice', { date: date(ent.endsAt ?? new Date()) })}
          </p>
        )}
        {q.resumed && (
          <p className="notice" role="status">
            {t('resumedNotice')}
          </p>
        )}
        {ent.state === 'past_due' && (
          <p className="notice notice--warn" role="alert">
            {t('pastDue')}
          </p>
        )}
        <section className="account-panel sub-status" aria-labelledby="sub-plan">
          <div className="account-panel__head">
            <h2 id="sub-plan">{t(`plans.${sub.plan}.name`)}</h2>
            <span className={`sub-state sub-state--${ent.state}`}>{t(`state.${ent.state}`)}</span>
          </div>
          <p>{t(`plans.${sub.plan}.short`)}</p>
          <dl className="sub-facts">
            <div>
              <dt>{t('devices')}</dt>
              <dd>{t('devicesValue', { total: ent.seats, extra: sub.extraDevices })}</dd>
            </div>
            {stripe && (
              <div>
                <dt>{t('price')}</dt>
                <dd>
                  <span className="num">{eur(monthly)}</span> {t('perMonth')}{' '}
                  <span className="muted small">
                    {behavior === 'incl' ? t('inclVat') : t('net')}
                  </span>
                </dd>
              </div>
            )}
            <div>
              <dt>{ent.endsAt ? t('endsOn') : ent.renewsAt ? t('renewsOn') : t('runs')}</dt>
              <dd>
                {ent.endsAt ? date(ent.endsAt) : ent.renewsAt ? date(ent.renewsAt) : t('noEnd')}
              </dd>
            </div>
          </dl>
          {sub.source === 'complimentary' && <p className="muted">{t('complimentary')}</p>}
        </section>

        {stripe && (
          <section className="account-panel" id="change" aria-labelledby="sub-change">
            <h2 id="sub-change">{t('changeTitle')}</h2>
            {change && (
              <p className={change === 'done' ? 'notice' : 'notice notice--warn'} role="status">
                {t(`change.${change}`, { inUse: Number(q.in_use ?? 0) })}
              </p>
            )}
            <form action={changeSubscriptionAction} className="sub-change">
              <input type="hidden" name="locale" value={locale} />
              <fieldset className="plan-pick plan-pick--compact">
                <legend className="visually-hidden">{t('form.planTitle')}</legend>
                {(['collector', 'creator'] as const).map((k) => (
                  <label key={k} className="plan-pick__opt">
                    <input type="radio" name="plan" value={k} defaultChecked={sub.plan === k} />
                    <span className="plan-pick__body">
                      <span className="plan-pick__head">
                        <strong>{t(`plans.${k}.name`)}</strong>
                        <span className="plan-pick__price">
                          <span className="num">
                            {eur(behavior === 'incl' ? prices[k] : netPrice(prices[k]))}
                          </span>{' '}
                          {t('perMonth')}
                        </span>
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <label className="field" htmlFor="chg-devices">
                <span>{t('form.extraDevices')}</span>
                <input
                  id="chg-devices"
                  name="extraDevices"
                  type="number"
                  min={0}
                  max={MAX_EXTRA_DEVICES}
                  defaultValue={sub.extraDevices}
                  inputMode="numeric"
                  className="subscribe__devices"
                />
                <small className="muted">
                  {t('changeDevicesHint', {
                    collector: eur(
                      behavior === 'incl'
                        ? prices.collector_device
                        : netPrice(prices.collector_device),
                    ),
                    creator: eur(
                      behavior === 'incl' ? prices.creator_device : netPrice(prices.creator_device),
                    ),
                  })}
                </small>
              </label>
              <p className="small muted">{t('changeNote')}</p>
              <button type="submit" className="btn">
                {t('changeSubmit')}
              </button>
            </form>
          </section>
        )}

        {stripe && (
          <section className="account-panel" aria-labelledby="sub-manage">
            <h2 id="sub-manage">{t('manageTitle')}</h2>
            <form action={billingPortalAction}>
              <input type="hidden" name="locale" value={locale} />
              <button type="submit" className="btn btn--quiet">
                {t('portal')}
              </button>
            </form>
            <p className="small muted">{t('portalNote')}</p>
            {sub.cancelAtPeriodEnd ? (
              <form action={cancelSubscriptionAction}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="resume" value="1" />
                <button type="submit" className="btn btn--accent">
                  {t('resume')}
                </button>
              </form>
            ) : (
              <details className="sub-cancel">
                <summary>{t('cancel')}</summary>
                <p>{t('cancelText', { date: date(ent.renewsAt ?? new Date()) })}</p>
                <form action={cancelSubscriptionAction}>
                  <input type="hidden" name="locale" value={locale} />
                  <button type="submit" className="btn btn--danger-outline">
                    {t('cancelConfirm')}
                  </button>
                </form>
              </details>
            )}
          </section>
        )}
      </AccountShell>
    );
  }

  // No running subscription: the plans and the form.
  const { errors = {}, values } = unpack(q.e);
  const tf = await getTranslations('Subscription.form');
  const errorTexts = Object.fromEntries(
    Object.entries(errors)
      .filter(([k]) => k !== '_')
      .map(([k, code]) => [k, tf(`errors.${code}` as never)]),
  );
  const billingInfo = (
    await db()<{ billing: Record<string, string> | null }[]>`
    SELECT billing FROM accounts WHERE id = ${account.id}`
  )[0]?.billing;
  const a = account.shippingAddress;
  const defaults: Record<string, string> = values ?? {
    plan: q.plan === 'creator' ? 'creator' : 'collector',
    extraDevices: '0',
    buyer: billingInfo?.buyer ?? 'consumer',
    name: billingInfo?.name ?? a?.name ?? account.name ?? '',
    company: billingInfo?.company ?? a?.company ?? '',
    vatId: billingInfo?.vat_id ?? '',
    street: billingInfo?.street ?? a?.street ?? '',
    postcode: billingInfo?.postcode ?? a?.postcode ?? '',
    city: billingInfo?.city ?? a?.city ?? '',
    country: billingInfo?.country ?? a?.country ?? '',
  };
  const names = new Intl.DisplayNames([locale === 'de' ? 'de-AT' : 'en'], { type: 'region' });
  const eu = (await db()<{ code: string }[]>`SELECT code FROM countries WHERE is_eu`)
    .map((c) => ({ code: c.code, name: names.of(c.code) ?? c.code }))
    .sort((x, y) => x.name.localeCompare(y.name, locale));
  const both = (c: number) => ({ gross: c, net: netPrice(c) });
  const planPrices: PlanPrices = {
    collector: both(prices.collector),
    creator: both(prices.creator),
    collector_device: both(prices.collector_device),
    creator_device: both(prices.creator_device),
  };
  return (
    <AccountShell account={account} active="subscription" title={t('title')} locale={locale}>
      {q.welcome && (
        <p className="notice" role="status">
          {t('activating')}
        </p>
      )}
      {q.cancelled && (
        <p className="notice notice--warn" role="status">
          {t('checkoutCancelled')}
        </p>
      )}
      {ent.state === 'ended' && <p className="notice notice--warn">{t('ended')}</p>}
      {errors._ && (
        <p className="notice notice--warn" role="alert">
          {errors._ === 'payment_unavailable' ? tf('paymentUnavailable') : tf('errorsTitle')}
        </p>
      )}
      {!errors._ && Object.keys(errors).length > 0 && (
        <p className="notice notice--warn" role="alert">
          {tf('errorsTitle')}
        </p>
      )}
      <p className="lead account-lead">{t('intro')}</p>
      <div className="plan-cards">
        {(['collector', 'creator'] as const).map((k) => (
          <section key={k} className={`plan-card plan-card--${k}`} aria-labelledby={`pc-${k}`}>
            <h2 id={`pc-${k}`}>{t(`plans.${k}.name`)}</h2>
            <p className="plan-card__price">
              <span className="num">{eur(prices[k])}</span> {t('perMonth')}
            </p>
            <ul className="app-ticks">
              {(t.raw(`plans.${k}.points`) as string[]).map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <p className="small muted">{t('extraDevice', { price: eur(prices[`${k}_device`]) })}</p>
          </section>
        ))}
      </div>
      <p className="small muted">{t('onRequest')}</p>
      <section className="account-panel" id="abo" aria-labelledby="sub-form">
        <h2 id="sub-form">{t('formTitle')}</h2>
        {b ? (
          <SubscribeForm
            action={subscribeAction}
            locale={locale}
            values={defaults}
            errors={errorTexts}
            euCountries={eu}
            prices={planPrices}
            sellerName={seller.name}
            sellerAddress={`${seller.street}, ${seller.postcode} ${seller.city}`}
          />
        ) : (
          <p className="notice notice--warn">{tf('closed')}</p>
        )}
      </section>
    </AccountShell>
  );
}
