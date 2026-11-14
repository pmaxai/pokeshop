/**
 * A card's price over time as a small SVG line: weekly for a year, then daily (the pack's
 * calendar). Gaps (no price that day) break the line.
 */
export function PriceChart({
  dates,
  values,
  locale,
  label,
}: {
  dates: string[];
  values: (number | null)[];
  locale: 'de' | 'en';
  label: string;
}) {
  const pts = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v !== null);
  if (pts.length < 2) return null;
  const W = 640;
  const H = 180;
  const PAD = { l: 8, r: 8, t: 14, b: 22 };
  const t0 = Date.parse(dates[0]!);
  const t1 = Date.parse(dates[dates.length - 1]!);
  const x = (i: number) =>
    PAD.l + ((Date.parse(dates[i]!) - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const min = Math.min(...pts.map((p) => p.v));
  const max = Math.max(...pts.map((p) => p.v));
  const span = max - min || max || 1;
  const y = (v: number) => PAD.t + (1 - (v - min) / span) * (H - PAD.t - PAD.b);
  // one path, with a new segment after each gap
  let d = '';
  let prev = -2;
  for (const p of pts) {
    d += `${p.i === prev + 1 ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`;
    prev = p.i;
  }
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const eur = (v: number) =>
    new Intl.NumberFormat(locale === 'de' ? 'de-AT' : 'en-IE', {
      style: 'currency',
      currency: 'EUR',
    }).format(v);
  const day = (s: string) =>
    new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
      month: 'short',
      year: 'numeric',
    }).format(new Date(`${s}T12:00:00Z`));
  const change = first.v ? Math.round(((last.v - first.v) / first.v) * 100) : 0;
  return (
    <figure className="price-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${label}: ${eur(first.v)} → ${eur(last.v)} (${change > 0 ? '+' : ''}${change} %)`}
      >
        <line x1={PAD.l} x2={W - PAD.r} y1={y(max)} y2={y(max)} className="price-chart__grid" />
        <line x1={PAD.l} x2={W - PAD.r} y1={y(min)} y2={y(min)} className="price-chart__grid" />
        <path d={d} className="price-chart__line" />
        <circle cx={x(last.i)} cy={y(last.v)} r="4" className="price-chart__dot" />
        <text x={PAD.l} y={y(max) - 4} className="price-chart__label">
          {eur(max)}
        </text>
        <text x={PAD.l} y={y(min) + 13} className="price-chart__label">
          {eur(min)}
        </text>
        <text x={PAD.l} y={H - 4} className="price-chart__label">
          {day(dates[0]!)}
        </text>
        <text x={W - PAD.r} y={H - 4} textAnchor="end" className="price-chart__label">
          {day(dates[dates.length - 1]!)}
        </text>
      </svg>
      <figcaption className="small muted">
        {label}: {eur(first.v)} → <strong>{eur(last.v)}</strong>{' '}
        <span className={change >= 0 ? 'price-up' : 'price-down'}>
          ({change > 0 ? '+' : ''}
          {change} %)
        </span>
      </figcaption>
    </figure>
  );
}
