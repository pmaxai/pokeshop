import { translationText, type CardNames } from '@pokeshop/core/catalog';

/**
 * English and (in the German shop) German name, shown smaller under the printed name, each with
 * its language: "Charizard ex (EN) · Glurak-ex (DE)".
 */
export function AltNames({
  translations,
  className = 'alt-names',
}: {
  translations: CardNames['translations'];
  className?: string;
}) {
  if (translations.length === 0) return null;
  return (
    <span className={className}>
      {translations.map((t, i) => (
        <span key={t.lang}>
          {i > 0 && ' · '}
          <span lang={t.lang}>{t.text}</span> ({t.lang.toUpperCase()})
        </span>
      ))}
    </span>
  );
}

/** "リザードンex · Charizard ex (EN) · Glurak-ex (DE)" for alt texts and titles. */
export function namesText(name: string, translations: CardNames['translations']): string {
  return [name, ...translations.map(translationText)].join(' · ');
}
