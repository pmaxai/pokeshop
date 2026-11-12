import { ImageResponse } from 'next/og';

// The share picture for pages without one of their own (cards bring their photo): the shop's
// card mark, its name and what it sells. Served as /og.png?l=de|en; the file-like path keeps it
// outside the language routing.

const INK = '#161c33';
const MUTED = '#586079';
const PAPER = '#f5f6f8';
const SLEEVE = '#e2e9f4';
const ACCENT = '#ef5b0c';
const ACCENT_TEXT = '#c2470a';

const TEXT = {
  en: ['Single Pokémon cards', 'Free shipping across the EU'],
  de: ['Pokémon-Einzelkarten', 'Versandkostenfrei in die ganze EU'],
} as const;

export async function GET(req: Request) {
  const locale = new URL(req.url).searchParams.get('l') === 'de' ? 'de' : 'en';
  const [line1, line2] = TEXT[locale];
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        background: PAPER,
        padding: '0 96px',
        gap: 80,
      }}
    >
      <div
        style={{
          width: 300,
          height: 400,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: SLEEVE,
          border: `8px solid ${INK}`,
          borderRadius: 28,
          transform: 'rotate(-6deg)',
        }}
      >
        <div
          style={{
            width: 210,
            height: 290,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: ACCENT,
            borderRadius: 14,
          }}
        >
          <div style={{ width: 92, height: 92, border: '12px solid #ffffff', borderRadius: 999 }} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', color: INK }}>
        <div style={{ display: 'flex', fontSize: 92, lineHeight: 1, letterSpacing: -2 }}>
          Overpriced
        </div>
        <div
          style={{ display: 'flex', fontSize: 92, lineHeight: 1, letterSpacing: -2, color: MUTED }}
        >
          Cardboard
        </div>
        <div style={{ display: 'flex', fontSize: 40, marginTop: 48 }}>{line1}</div>
        <div style={{ display: 'flex', fontSize: 40, color: ACCENT_TEXT }}>{line2}</div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      headers: { 'cache-control': 'public, max-age=86400, stale-while-revalidate=604800' },
    },
  );
}
