import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { getCompany } from '@/server/shop';
import { withdrawAction } from '../shop-actions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ ok?: string; e?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Withdraw' });
  return { title: t('title') };
}

type Flash = { values?: Record<string, string>; errors?: Record<string, string> };

export default async function WithdrawPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const t = await getTranslations('Withdraw');
  const te = await getTranslations('Checkout');
  const company = await getCompany();

  if (sp.ok) {
    const at = new Date(sp.ok);
    const time = Number.isNaN(at.getTime())
      ? ''
      : new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
          dateStyle: 'long',
          timeStyle: 'medium',
          timeZone: 'Europe/Vienna',
        }).format(at);
    return (
      <div className="wrap prose">
        <h1>{t('done')}</h1>
        <p className="lead">
          {t('doneText', {
            time,
            address: `${company.name}, ${company.street}, ${company.postcode} ${company.city}`,
          })}
        </p>
      </div>
    );
  }

  let flash: Flash = {};
  if (sp.e) {
    try {
      const raw = (await cookies()).get('pk_withdraw')?.value;
      if (raw) flash = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Flash;
    } catch {
      flash = {};
    }
  }
  const v = flash.values ?? {};
  const errors = flash.errors ?? {};
  const field = (
    name: string,
    label: string,
    opts: { type?: string; area?: boolean; required?: boolean; autoComplete?: string } = {},
  ) => {
    const code = errors[name];
    const id = `w-${name}`;
    const common = {
      id,
      name,
      defaultValue: v[name] ?? '',
      required: opts.required ?? false,
      autoComplete: opts.autoComplete,
      'aria-invalid': code ? true : undefined,
      'aria-describedby': code ? `${id}-err` : undefined,
    } as const;
    return (
      <label className={code ? 'field field--error' : 'field'} htmlFor={id}>
        <span>{label}</span>
        {opts.area ? (
          <textarea rows={4} {...common} />
        ) : (
          <input type={opts.type ?? 'text'} {...common} />
        )}
        {code && (
          <small id={`${id}-err`} className="field__error">
            {te(`errors.${code}` as never)}
          </small>
        )}
      </label>
    );
  };

  return (
    <div className="wrap withdraw-page">
      <h1>{t('title')}</h1>
      <p className="lead">{t('intro')}</p>
      {Object.keys(errors).length > 0 && (
        <p className="notice notice--warn" role="alert">
          {t('errorsTitle')}
        </p>
      )}
      <form action={withdrawAction} className="stack" noValidate>
        <input type="hidden" name="locale" value={locale} />
        {field('name', t('name'), { required: true, autoComplete: 'name' })}
        {field('email', t('email'), { type: 'email', required: true, autoComplete: 'email' })}
        {field('order_number', t('orderNumber'))}
        {field('order_date', t('orderDate'))}
        {field('items', t('items'), { area: true })}
        {field('message', t('message'), { area: true })}
        <button type="submit" className="btn btn--accent">
          {t('submit')}
        </button>
      </form>
      <p className="muted">
        {t.rich('info', { link: (c) => <Link href="/widerrufsbelehrung">{c}</Link> })}
      </p>
    </div>
  );
}
