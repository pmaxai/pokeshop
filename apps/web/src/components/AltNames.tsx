import type { CardNames } from '@pokeshop/core/catalog';

/** English and (in the German shop) German name, shown smaller under the printed name. */
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
          <span lang={t.lang}>{t.text}</span>
        </span>
      ))}
    </span>
  );
}

/** "リザードンex (Charizard ex, Glurak-ex)" for alt texts and titles. */
export function namesText(name: string, translations: CardNames['translations']): string {
  return translations.length ? `${name} (${translations.map((t) => t.text).join(', ')})` : name;
}
