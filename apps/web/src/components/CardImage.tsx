import type { CardImage as Img } from '@pokeshop/core/storefront';

const OWN_WIDTHS = [320, 640, 1200] as const;

/** A card at true card proportions inside a toploader frame. */
export function CardImage({
  image,
  alt,
  sizes = '(min-width: 48rem) 12rem, 45vw',
  priority = false,
  noImageLabel,
  large = false,
}: {
  image: Img;
  alt: string;
  sizes?: string;
  priority?: boolean;
  noImageLabel: string;
  large?: boolean;
}) {
  const loading = priority ? 'eager' : 'lazy';
  let content: React.ReactNode;
  if (image.kind === 'own' && image.key) {
    const set = (fmt: string) =>
      OWN_WIDTHS.map((w) => `/media/${image.key}-${w}.${fmt} ${w}w`).join(', ');
    content = (
      <picture>
        <source type="image/avif" srcSet={set('avif')} sizes={sizes} />
        <img
          src={`/media/${image.key}-${large ? 1200 : 640}.webp`}
          srcSet={set('webp')}
          sizes={sizes}
          alt={alt}
          width={image.width ?? 630}
          height={image.height ?? 880}
          loading={loading}
          decoding="async"
          fetchPriority={priority ? 'high' : 'auto'}
        />
      </picture>
    );
  } else if (image.kind === 'sample' && image.samplePath) {
    const base = `/media/card/${image.samplePath}`;
    content = (
      <img
        src={`${base}/${large ? 'high' : 'low'}.webp`}
        srcSet={`${base}/low.webp 245w, ${base}/high.webp 600w`}
        sizes={sizes}
        alt={alt}
        width={600}
        height={825}
        loading={loading}
        decoding="async"
        fetchPriority={priority ? 'high' : 'auto'}
      />
    );
  } else {
    content = (
      <div className="card-back" role="img" aria-label={alt}>
        {noImageLabel}
      </div>
    );
  }
  return <div className="toploader">{content}</div>;
}
