// JSON Web Tokens with node:crypto: checking Google's and Apple's signed tokens (ID tokens,
// Pub/Sub push tokens) against their published keys, and signing the service-account token
// for Google's APIs. RS256 and ES256 only.
import { createPublicKey, createSign, createVerify, type KeyObject } from 'node:crypto';

export class JwtError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export type JwtParts = {
  header: { alg?: string; kid?: string; typ?: string; x5c?: string[] };
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
};

const b64json = (s: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new JwtError('malformed');
  return v as Record<string, unknown>;
};

export function decodeJwt(token: string): JwtParts {
  if (typeof token !== 'string' || token.length > 16_384) throw new JwtError('malformed');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) {
    throw new JwtError('malformed');
  }
  try {
    return {
      header: b64json(parts[0]!) as JwtParts['header'],
      payload: b64json(parts[1]!),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2]!, 'base64url'),
    };
  } catch (e) {
    if (e instanceof JwtError) throw e;
    throw new JwtError('malformed');
  }
}

/** Checks the signature of the decoded token with a public key (RS256 or ES256). */
export function verifySignature(parts: JwtParts, key: KeyObject): boolean {
  const alg = parts.header.alg;
  if (alg === 'RS256') {
    return createVerify('RSA-SHA256').update(parts.signingInput).verify(key, parts.signature);
  }
  if (alg === 'ES256') {
    // JWS carries the raw r||s signature (64 bytes), not DER
    return createVerify('SHA256')
      .update(parts.signingInput)
      .verify({ key, dsaEncoding: 'ieee-p1363' }, parts.signature);
  }
  return false;
}

export type KeyLookup = (kid: string | undefined, alg: string | undefined) => Promise<KeyObject>;

export type VerifyOptions = {
  keys: KeyLookup;
  issuers: string[];
  audiences: string[];
  now?: Date;
  /** seconds of clock difference accepted */
  skew?: number;
};

/** A signed token whose signature, issuer, audience and times check out; its claims. */
export async function verifyJwt(
  token: string,
  opts: VerifyOptions,
): Promise<Record<string, unknown>> {
  const parts = decodeJwt(token);
  const { alg, kid } = parts.header;
  if (alg !== 'RS256' && alg !== 'ES256') throw new JwtError('algorithm');
  const key = await opts.keys(kid, alg);
  if (!verifySignature(parts, key)) throw new JwtError('signature');
  const c = parts.payload;
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const skew = opts.skew ?? 60;
  if (typeof c.exp !== 'number' || c.exp + skew < now) throw new JwtError('expired');
  if (typeof c.iat === 'number' && c.iat - skew > now) throw new JwtError('not_yet_valid');
  if (typeof c.nbf === 'number' && c.nbf - skew > now) throw new JwtError('not_yet_valid');
  if (typeof c.iss !== 'string' || !opts.issuers.includes(c.iss)) throw new JwtError('issuer');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (opts.audiences.length === 0 || !aud.some((a) => opts.audiences.includes(String(a)))) {
    throw new JwtError('audience');
  }
  return c;
}

type Jwk = { kid?: string; kty: string; alg?: string; [k: string]: unknown };

/**
 * Keys from a JWKS address (Google's or Apple's), kept for 6 hours. An unknown key id fetches
 * again (keys rotate), at most once a minute.
 */
export function remoteKeys(url: string, fetchFn: typeof fetch = fetch): KeyLookup {
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;
  let pending: Promise<void> | null = null;
  const load = async () => {
    const r = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new JwtError('keys_unavailable', `${url}: HTTP ${r.status}`);
    const body = (await r.json()) as { keys?: Jwk[] };
    const next = new Map<string, KeyObject>();
    for (const k of body.keys ?? []) {
      if (!k.kid) continue;
      try {
        next.set(k.kid, createPublicKey({ key: k as never, format: 'jwk' }));
      } catch {
        // a key type we don't use
      }
    }
    keys = next;
    fetchedAt = Date.now();
  };
  return async (kid) => {
    if (!kid) throw new JwtError('no_kid');
    const age = Date.now() - fetchedAt;
    if (age > 6 * 3600_000 || (!keys.has(kid) && age > 60_000)) {
      pending ??= load().finally(() => (pending = null));
      await pending;
    }
    const key = keys.get(kid);
    if (!key) throw new JwtError('unknown_key');
    return key;
  };
}

/** Fixed keys (tests, or keys given in the configuration). */
export function localKeys(map: Record<string, KeyObject>): KeyLookup {
  return async (kid) => {
    const key = kid ? map[kid] : undefined;
    if (!key) throw new JwtError('unknown_key');
    return key;
  };
}

/** Signs claims with an RSA private key (PEM) as RS256. */
export function signRs256(
  claims: Record<string, unknown>,
  privateKeyPem: string,
  kid?: string,
): string {
  const header = { alg: 'RS256', typ: 'JWT', ...(kid ? { kid } : {}) };
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(
    JSON.stringify(claims),
  ).toString('base64url')}`;
  const sig = createSign('RSA-SHA256').update(input).sign(privateKeyPem);
  return `${input}.${sig.toString('base64url')}`;
}
