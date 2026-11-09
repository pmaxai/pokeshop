import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import type { Locale } from '@/i18n/routing';
import { LegalPage, legalTitle } from '@/components/LegalPage';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return { title: (await legalTitle('license_terms', locale)) ?? undefined };
}

/** Licence terms of Antalyse GmbH, seller of the app licences (with withdrawal and privacy). */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <LegalPage kind="license_terms" locale={locale} />;
}
