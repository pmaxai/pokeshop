import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import {
  GIFT_VOUCHER_MAX_CENTS,
  GIFT_VOUCHER_MIN_CENTS,
  GIFT_VOUCHER_PRESETS,
} from '@pokeshop/core/vouchers';
import type { Locale } from '@/i18n/routing';
import { VOUCHER_FORM_FLASH } from '@/server/app-form';
import { payments } from '@/server/payments';
import { GiftVoucherForm } from '@/components/GiftVoucherForm';
import { buyVoucherAction } from '../voucher-actions';
import { pageAlternates } from '@/server/seo';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<Record<string, string | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Vouchers' });
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: pageAlternates('/gutscheine', locale),
  };
}

type Flash = { values?: Record<string, string>; errors?: Record<string, string> };

/** Gift vouchers for cards: choose an amount, write a line, get the PDF by e-mail. */
export default async function VouchersPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const t = await getTranslations('Vouchers');
  let flash: Flash = {};
  if (sp.e) {
    const raw = (await cookies()).get(VOUCHER_FORM_FLASH)?.value;
    try {
      flash = raw ? (JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Flash) : {};
    } catch {
      flash = {};
    }
  }
  const errors = flash.errors ?? {};
  const texts = Object.fromEntries(
    Object.entries(errors)
      .filter(([k]) => k !== '_')
      .map(([k, code]) => [k, t(`errors.${code}` as 'errors.required')]),
  );
  const open = payments('shop') !== null;

  return (
    <div className="wrap gv-page">
      <header className="gv-head">
        <h1>{t('title')}</h1>
        <p className="lead">{t('lead')}</p>
        <ul className="gv-points">
          <li>{t('pointCards')}</li>
          <li>{t('pointNoExpiry')}</li>
          <li>{t('pointBalance')}</li>
        </ul>
      </header>
      <section id="kaufen" aria-label={t('buyLabel')}>
        {sp.cancelled && (
          <p className="notice notice--warn" role="status">
            {t('cancelled')}
          </p>
        )}
        {errors._ && (
          <p className="notice notice--warn" role="alert">
            {t('paymentUnavailable')}
          </p>
        )}
        {Object.keys(texts).length > 0 && (
          <p className="notice notice--warn" role="alert">
            {t('errorsTitle')}
          </p>
        )}
        {open ? (
          <GiftVoucherForm
            action={buyVoucherAction}
            locale={locale}
            presets={GIFT_VOUCHER_PRESETS}
            minCents={GIFT_VOUCHER_MIN_CENTS}
            maxCents={GIFT_VOUCHER_MAX_CENTS}
            values={flash.values ?? {}}
            errors={texts}
          />
        ) : (
          <p className="notice notice--warn">{t('closed')}</p>
        )}
      </section>
      <section className="gv-how" aria-labelledby="gv-how-title">
        <h2 id="gv-how-title">{t('howTitle')}</h2>
        <ol className="app-steps">
          <li>{t('how1')}</li>
          <li>{t('how2')}</li>
          <li>{t('how3')}</li>
        </ol>
        <p className="muted small">{t('howNote')}</p>
      </section>
    </div>
  );
}
