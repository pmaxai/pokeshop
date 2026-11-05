import { getTranslations } from 'next-intl/server';
import { currentLegal, legalHtml, type LegalKind } from '@pokeshop/core/legal';
import type { Locale } from '@/i18n/routing';
import { config, db } from '@/server/config';
import { getCompany } from '@/server/shop';

export async function legalTitle(kind: LegalKind, locale: Locale): Promise<string | null> {
  return (await currentLegal(db(), kind, locale))?.title ?? null;
}

/** Terms, withdrawal instructions or privacy policy, from the version stored at migrate. */
export async function LegalPage({ kind, locale }: { kind: LegalKind; locale: Locale }) {
  const t = await getTranslations('Legal');
  const text = await currentLegal(db(), kind, locale);
  const company = (await getCompany()) as unknown as Record<string, unknown>;
  if (!text) {
    return (
      <div className="wrap prose">
        <p>{t('missing', { email: String(company.email ?? 'bestellung@pokemonkarten.at') })}</p>
      </div>
    );
  }
  const html = legalHtml(text.body_md, { company, baseUrl: config.baseUrl, locale });
  return (
    <article className="wrap prose legal">
      <h1>{text.title}</h1>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <p className="muted small">{t('version', { version: text.version })}</p>
    </article>
  );
}
