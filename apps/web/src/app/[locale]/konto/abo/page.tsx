import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import { licenseSeller } from '@pokeshop/core/licenses';
import {
  accountServices,
  deviceSubscriptionOf,
  deviceSubscriptionRunning,
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
import { billingPeriodStart, usageSince } from '@pokeshop/core/usage';
import { MAX_STORE_DEVICES, storeManageUrl, storeProducts } from '@pokeshop/core/store';
import { maxWebDevices } from '@pokeshop/core/device-subscriptions';
import { accountAffiliate, affiliateDiscount } from '@pokeshop/core/affiliates';
import { accountAddons, withAddons } from '@pokeshop/core/addons';
import { ADDONS } from '@pokeshop/core/addon-catalog';
import { cookieAffiliate } from '@/server/affiliate';
import { AccountShell } from '@/components/account/AccountShell';
import { SubscribeForm, type PlanPrices } from '@/components/account/SubscribeForm';
import {
  billingPortalAction,
  cancelSubscriptionAction,
  changeDevicesAction,
  changeSubscriptionAction,
  subscribeAction,
  subscribeDevicesAction,
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

const DEVICES_MESSAGES = [
  'added',
  'cancelled',
  'done',
  'ending',
  'devices_in_use',
  'unchanged',
  'payment_failed',
  'failed',
  'invalid',
  'not_active',
  'already_active',
  'no_store_subscription',
] as const;

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
  const [sub, services, prices, seller, addons, products] = await Promise.all([
    subscriptionOf(db(), account.id),
    accountServices(db(), account.id),
    subscriptionPrices(db()),
    licenseSeller(db()),
    accountAddons(db(), account.id),
    storeProducts(db()),
  ]);
  const ent = withAddons(entitlements(sub, account, new Date(), services), addons, products.addons);
  const eur = (c: number) => formatEuro(c, locale);
  const date = (d: Date) =>
    new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
      dateStyle: 'long',
      timeZone: 'Europe/Vienna',
    }).format(d);

  // usage services the shop switched on (S3 storage, video pipeline): what was used so far
  const usage =
    ent.active && (services.s3 || services.pipeline)
      ? await usageSince(db(), account.id, await billingPeriodStart(db(), account.id))
      : null;
  const num = (v: number, digits: number) =>
    v.toLocaleString(locale === 'de' ? 'de-AT' : 'en-GB', { maximumFractionDigits: digits });

  // the billing form (website subscription, or extra devices for a store subscription)
  const { errors = {}, values } = unpack(q.e);
  const tf = await getTranslations('Subscription.form');
  const errorTexts = Object.fromEntries(
    Object.entries(errors)
      .filter(([k]) => k !== '_')
      .map(([k, code]) => [k, tf(`errors.${code}` as never)]),
  );
  const formDefaults = async (plan: string, devices: string) => {
    const billingInfo = (
      await db()<{ billing: Record<string, string> | null }[]>`
      SELECT billing FROM accounts WHERE id = ${account.id}`
    )[0]?.billing;
    const a = account.shippingAddress;
    return (
      values ?? {
        plan,
        extraDevices: devices,
        buyer: billingInfo?.buyer ?? 'consumer',
        name: billingInfo?.name ?? a?.name ?? account.name ?? '',
        company: billingInfo?.company ?? a?.company ?? '',
        vatId: billingInfo?.vat_id ?? '',
        street: billingInfo?.street ?? a?.street ?? '',
        postcode: billingInfo?.postcode ?? a?.postcode ?? '',
        city: billingInfo?.city ?? a?.city ?? '',
        country: billingInfo?.country ?? a?.country ?? '',
      }
    );
  };
  const euCountries = async () => {
    const names = new Intl.DisplayNames([locale === 'de' ? 'de-AT' : 'en'], { type: 'region' });
    return (await db()<{ code: string }[]>`SELECT code FROM countries WHERE is_eu`)
      .map((c) => ({ code: c.code, name: names.of(c.code) ?? c.code }))
      .sort((x, y) => x.name.localeCompare(y.name, locale));
  };
  const both = (c: number) => ({ gross: c, net: netPrice(c) });
  const planPrices: PlanPrices = {
    collector: both(prices.collector),
    creator: both(prices.creator),
    collector_device: both(prices.collector_device),
    creator_device: both(prices.creator_device),
  };

  if (ent.active && sub) {
    const behavior = sub.taxBehavior ?? 'incl';
    const monthly = monthlyCents(prices, sub.plan, sub.extraDevices, behavior);
    const change = CHANGE_MESSAGES.find((c) => c === q.change);
    const stripe = sub.source === 'stripe';
    const inStore = sub.source === 'google_play' || sub.source === 'app_store';
    const storeName = inStore ? t(`store.${sub.source as 'google_play' | 'app_store'}`) : '';
    // extra devices in the portal for a store subscription
    const web = inStore ? await deviceSubscriptionOf(db(), account.id) : null;
    const webRuns = web ? deviceSubscriptionRunning(web) : false;
    const webBehavior = web?.taxBehavior ?? 'incl';
    const deviceCents = (b: 'incl' | 'excl') =>
      b === 'incl' ? prices[`${sub.plan}_device`] : netPrice(prices[`${sub.plan}_device`]);
    const devicesMsg = DEVICES_MESSAGES.find((c) => c === q.devices);
    const deviceForm =
      inStore && !webRuns && b
        ? {
            values: await formDefaults(sub.plan, '1'),
            countries: await euCountries(),
          }
        : null;
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
              <dd>
                {t('devicesValue', { total: ent.seats, extra: sub.extraDevices })}
                {inStore && sub.extraDevices > 0 && (
                  <span className="muted small">
                    {' '}
                    {t('devicesShop.breakdown', {
                      store: storeName,
                      inStore: sub.devicesInStore ?? 0,
                      web: sub.devicesOnWeb ?? 0,
                    })}
                  </span>
                )}
              </dd>
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
          {(sub.source === 'google_play' || sub.source === 'app_store') && (
            <p className="sub-store">
              {t('store.text', { store: t(`store.${sub.source}`) })}{' '}
              <a
                href={storeManageUrl(sub.source, sub.storeProductId)}
                target="_blank"
                rel="noreferrer"
              >
                {t('store.manage', { store: t(`store.${sub.source}`) })}
              </a>
            </p>
          )}
        </section>

        {addons.length > 0 && (
          <section className="account-panel" id="addons" aria-labelledby="sub-addons">
            <h2 id="sub-addons">{t('addons.title')}</h2>
            <p className="muted">{t('addons.intro')}</p>
            <ul className="plain">
              {addons.map((a) => {
                const store = a.source === 'app_store' ? 'App Store' : 'Google Play';
                const counts = ent.features[ADDONS[a.id].feature];
                return (
                  <li key={a.id}>
                    <strong>{ADDONS[a.id].name[locale]}</strong>: {t(`addons.state.${a.state}`)}
                    {a.renewsAt && (
                      <>
                        {' · '}
                        {t('renewsOn')} {date(a.renewsAt)}
                      </>
                    )}
                    {!a.renewsAt && a.endsAt && a.runs && (
                      <>
                        {' · '}
                        {t('endsOn')} {date(a.endsAt)}
                      </>
                    )}
                    {a.runs && (
                      <>
                        {' · '}
                        {counts
                          ? t('addons.counts')
                          : t('addons.notCounting', {
                              plans: products.addons[a.id].plans
                                .map((p) => t(`plans.${p}.name`))
                                .join(', '),
                            })}
                      </>
                    )}
                    <div className="small muted">
                      {a.source === 'web' ? t('addons.gift') : t('addons.fromStore', { store })}
                    </div>
                    {a.runs && a.source !== 'web' && !counts && (
                      <div className="small">{t('addons.storeKeepsBilling', { store })}</div>
                    )}
                    {a.runs && a.manageUrl && (
                      <div className="small">
                        <a href={a.manageUrl}>{t('addons.manage', { store })}</a>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {inStore && (
          <section className="account-panel" id="devices" aria-labelledby="sub-extra-devices">
            <h2 id="sub-extra-devices">{t('devicesShop.title')}</h2>
            {devicesMsg && (
              <p
                className={
                  ['added', 'done', 'ending'].includes(devicesMsg)
                    ? 'notice'
                    : 'notice notice--warn'
                }
                role="status"
              >
                {t(`devicesShop.notice.${devicesMsg}`, {
                  inUse: Number(q.in_use ?? 0),
                  store: storeName,
                })}
              </p>
            )}
            <p>
              {t('devicesShop.intro', {
                store: storeName,
                max: MAX_STORE_DEVICES,
                price: eur(prices[`${sub.plan}_device`]),
                plan: t(`plans.${sub.plan}.name`),
              })}
            </p>
            {web && webRuns ? (
              <>
                <dl className="sub-facts">
                  <div>
                    <dt>{t('devicesShop.here')}</dt>
                    <dd>{web.devices}</dd>
                  </div>
                  <div>
                    <dt>{t('price')}</dt>
                    <dd>
                      <span className="num">{eur(web.devices * deviceCents(webBehavior))}</span>{' '}
                      {t('perMonth')}{' '}
                      <span className="muted small">
                        {webBehavior === 'incl' ? t('inclVat') : t('net')}
                      </span>
                    </dd>
                  </div>
                  {web.currentPeriodEnd && (
                    <div>
                      <dt>{web.cancelAtPeriodEnd ? t('endsOn') : t('renewsOn')}</dt>
                      <dd>{date(web.currentPeriodEnd)}</dd>
                    </div>
                  )}
                </dl>
                <form action={changeDevicesAction} className="sub-change">
                  <input type="hidden" name="locale" value={locale} />
                  <label className="field" htmlFor="dev-count">
                    <span>{t('devicesShop.here')}</span>
                    <input
                      id="dev-count"
                      name="devices"
                      type="number"
                      min={0}
                      max={maxWebDevices(sub)}
                      defaultValue={web.cancelAtPeriodEnd ? 0 : web.devices}
                      inputMode="numeric"
                      className="subscribe__devices"
                    />
                    <small className="muted">{t('devicesShop.zeroHint')}</small>
                  </label>
                  <p className="small muted">{t('changeNote')}</p>
                  <button type="submit" className="btn">
                    {t('devicesShop.change')}
                  </button>
                </form>
                <form action={billingPortalAction}>
                  <input type="hidden" name="locale" value={locale} />
                  <button type="submit" className="btn btn--quiet">
                    {t('portal')}
                  </button>
                </form>
              </>
            ) : deviceForm ? (
              <>
                {errors._ && (
                  <p className="notice notice--warn" role="alert">
                    {errors._ === 'payment_unavailable'
                      ? tf('paymentUnavailable')
                      : tf('errorsTitle')}
                  </p>
                )}
                <SubscribeForm
                  action={subscribeDevicesAction}
                  locale={locale}
                  values={deviceForm.values}
                  errors={errorTexts}
                  euCountries={deviceForm.countries}
                  prices={planPrices}
                  sellerName={seller.name}
                  sellerAddress={`${seller.street}, ${seller.postcode} ${seller.city}`}
                  devicesOnly={{ plan: sub.plan, max: maxWebDevices(sub) }}
                />
              </>
            ) : (
              <p className="notice notice--warn">{tf('closed')}</p>
            )}
            <p className="small muted">{t('devicesShop.endNote', { store: storeName })}</p>
          </section>
        )}

        {usage && (
          <section className="account-panel" id="usage" aria-labelledby="sub-usage">
            <h2 id="sub-usage">{t('usage.title')}</h2>
            <p className="muted small">{t('usage.since', { date: date(usage.since) })}</p>
            <dl className="sub-facts">
              {services.s3 && (
                <div>
                  <dt>{t('usage.s3')}</dt>
                  <dd>
                    {num(usage.s3.mb / 1024, 2)} GB
                    {usage.s3.cents !== null && stripe && <> · ≈ {eur(usage.s3.cents)}</>}
                  </dd>
                </div>
              )}
              {services.pipeline && (
                <div>
                  <dt>{t('usage.pipeline')}</dt>
                  <dd>
                    {num(usage.pipeline.seconds / 60, 1)} min
                    {usage.pipeline.cents !== null && stripe && (
                      <> · ≈ {eur(usage.pipeline.cents)}</>
                    )}
                  </dd>
                </div>
              )}
            </dl>
            <p className="muted small">{stripe ? t('usage.billed') : t('usage.notBilled')}</p>
          </section>
        )}

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
  // the affiliate code: registered on the account, else the one from the visitor's link
  const [registered, discount, fromLink] = await Promise.all([
    accountAffiliate(db(), account.id),
    affiliateDiscount(db(), account.id),
    cookieAffiliate(),
  ]);
  const affiliate = discount
    ? { code: discount.code, percent: discount.percent, months: discount.months, saved: true }
    : !registered && fromLink
      ? {
          code: fromLink.code,
          percent: fromLink.discountPercent,
          months: fromLink.discountMonths,
          saved: false,
        }
      : null;
  const defaults: Record<string, string> = await formDefaults(
    q.plan === 'creator' ? 'creator' : 'collector',
    '0',
  );
  const eu = await euCountries();
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
            affiliate={affiliate}
          />
        ) : (
          <p className="notice notice--warn">{tf('closed')}</p>
        )}
      </section>
    </AccountShell>
  );
}
