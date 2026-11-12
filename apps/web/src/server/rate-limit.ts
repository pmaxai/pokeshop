/**
 * Counts events per key in memory (one web process; a restart forgets everything). Nothing is
 * written anywhere, so a visitor's IP address is never stored.
 */
const hits = new Map<string, number[]>();

export function rateLimited(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  const limited = recent.length >= max;
  if (!limited) recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  }
  return limited;
}

/** The visitor's address as Caddy passes it on (X-Forwarded-For), else "unknown". */
export function clientIp(h: { get(name: string): string | null }): string {
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip')?.trim() || 'unknown';
}
