import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import type { Locale } from '@/i18n/routing';
import { LegalPage, legalTitle } from '@/components/LegalPage';
import { pageAlternates } from '@/server/seo';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: (await legalTitle('app_privacy', locale)) ?? undefined,
    alternates: pageAlternates('/app/datenschutz', locale),
  };
}

/** Privacy policy of the scanner app (Antalyse GmbH); its URL goes into the store consoles. */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <LegalPage kind="app_privacy" locale={locale} />;
}
