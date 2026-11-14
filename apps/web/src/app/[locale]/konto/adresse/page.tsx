import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { safeNextPath } from '@pokeshop/core/accounts';
import { deliveryCountries } from '@pokeshop/core/cart';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { requireAccount } from '@/server/account';
import { AccountShell } from '@/components/account/AccountShell';
import { saveAddressAction } from '../../account-actions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ e?: string; saved?: string; removed?: string; next?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Account' });
  return { title: t('address.title'), robots: { index: false } };
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

const FIELD_ERRORS = ['required', 'too_long', 'invalid_postcode', 'invalid', 'country'] as const;

export default async function AccountAddressPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const account = await requireAccount(locale, getPathname({ href: '/konto/adresse', locale }));
  const t = await getTranslations('Account');
  const q = await searchParams;
  const { errors = {}, values } = unpack(q.e);
  const a = account.shippingAddress;
  const v: Record<string, string> = values ?? {
    name: a?.name ?? account.name ?? '',
    company: a?.company ?? '',
    street: a?.street ?? '',
    postcode: a?.postcode ?? '',
    city: a?.city ?? '',
    country: a?.country ?? 'AT',
    phone: account.phone ?? '',
  };
  const names = new Intl.DisplayNames([locale === 'de' ? 'de-AT' : 'en'], { type: 'region' });
  const countries = (await deliveryCountries(db()))
    .map((c) => ({ code: c.code, name: names.of(c.code) ?? c.code }))
    .sort((x, y) => x.name.localeCompare(y.name, locale));
  const next = safeNextPath(q.next);

  const field = (
    name: string,
    opts: {
      autoComplete?: string;
      required?: boolean;
      type?: string;
      inputMode?: 'numeric' | 'tel';
    } = {},
  ) => {
    const code = FIELD_ERRORS.find((c) => c === errors[name]);
    const id = `a-${name}`;
    return (
      <label className={code ? 'field field--error' : 'field'} htmlFor={id}>
        <span>{t(`address.${name}` as never)}</span>
        <input
          id={id}
          name={name}
          type={opts.type ?? 'text'}
          defaultValue={v[name] ?? ''}
          autoComplete={opts.autoComplete}
          required={opts.required ?? true}
          inputMode={opts.inputMode}
          aria-invalid={code ? true : undefined}
          aria-describedby={code ? `${id}-err` : undefined}
        />
        {code && (
          <small id={`${id}-err`} className="field__error">
            {t(`errors.${code}`)}
          </small>
        )}
      </label>
    );
  };

  return (
    <AccountShell account={account} active="address" title={t('address.title')} locale={locale}>
      <p className="muted">{t('address.intro')}</p>
      {q.saved && (
        <p className="notice" role="status">
          {t('address.saved')}
        </p>
      )}
      {q.removed && (
        <p className="notice" role="status">
          {t('address.removed')}
        </p>
      )}
      {Object.keys(errors).length > 0 && (
        <p className="notice notice--warn" role="alert">
          {t('errors.title')}
        </p>
      )}
      <form action={saveAddressAction} className="account-form stack" noValidate>
        <input type="hidden" name="locale" value={locale} />
        {next && <input type="hidden" name="next" value={next} />}
        {field('name', { autoComplete: 'shipping name' })}
        {field('company', { autoComplete: 'shipping organization', required: false })}
        {field('street', { autoComplete: 'shipping street-address' })}
        <div className="field-row">
          {field('postcode', { autoComplete: 'shipping postal-code', inputMode: 'numeric' })}
          {field('city', { autoComplete: 'shipping address-level2' })}
        </div>
        <label className={errors.country ? 'field field--error' : 'field'} htmlFor="a-country">
          <span>{t('address.country')}</span>
          <select
            id="a-country"
            name="country"
            defaultValue={v.country}
            autoComplete="shipping country"
          >
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
          {errors.country && <small className="field__error">{t('errors.country')}</small>}
        </label>
        {field('phone', { autoComplete: 'tel', required: false, type: 'tel', inputMode: 'tel' })}
        <div className="account-form__actions">
          <button type="submit" className="btn btn--accent">
            {t('address.save')}
          </button>
          {a && (
            <button type="submit" name="remove" value="1" className="btn btn--quiet" formNoValidate>
              {t('address.remove')}
            </button>
          )}
        </div>
      </form>
    </AccountShell>
  );
}
