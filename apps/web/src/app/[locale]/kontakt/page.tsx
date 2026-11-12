import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { createChallenge } from '@pokeshop/core/contact';
import type { Locale } from '@/i18n/routing';
import { apiMasterKey } from '@/server/config';
import { getCompany } from '@/server/shop';
import { pageAlternates } from '@/server/seo';
import { ContactForm } from '@/components/ContactForm';
import { contactAction } from '../contact-actions';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Contact' });
  return {
    title: t('title'),
    description: t('metaDescription'),
    alternates: pageAlternates('/kontakt', locale),
  };
}

export default async function ContactPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Contact');
  const { email } = await getCompany();
  const mail = (chunks: React.ReactNode) => <a href={`mailto:${email}`}>{chunks}</a>;
  return (
    <div className="wrap contact-page">
      <h1>{t('title')}</h1>
      <p className="lead">{t.rich('intro', { email: String(email), mail })}</p>
      {/* A fresh challenge per page view; the form cannot work without JavaScript. */}
      <ContactForm
        action={contactAction}
        locale={locale}
        challenge={createChallenge(apiMasterKey())}
      />
      <noscript>
        <p className="notice notice--warn">{t.rich('noscript', { email: String(email), mail })}</p>
      </noscript>
    </div>
  );
}
