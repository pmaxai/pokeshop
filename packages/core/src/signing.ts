import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * HMAC request signing for the product API (scanning app → shop).
 *
 * Headers on every request:
 *   X-Key-Id:    the API client's key id
 *   X-Timestamp: Unix time in seconds
 *   X-Signature: v1=<hex HMAC-SHA256>
 *
 * Signed string (lines joined with "\n"):
 *   <timestamp>
 *   <METHOD in upper case>
 *   <path including query string, exactly as sent, e.g. /api/v1/products?status=active>
 *   <hex SHA-256 of the raw request body; of the empty string when there is no body>
 *
 * The HMAC key is the secret exactly as shown in the admin, as UTF-8 bytes.
 */

export const SIGNATURE_VERSION = 'v1';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignableRequest = {
  timestamp: number | string;
  method: string;
  pathWithQuery: string;
  body: string | Uint8Array | null | undefined;
};

export function sha256Hex(data: string | Uint8Array | null | undefined): string {
  return createHash('sha256')
    .update(data ?? '')
    .digest('hex');
}

export function canonicalString(req: SignableRequest): string {
  return [
    String(req.timestamp),
    req.method.toUpperCase(),
    req.pathWithQuery,
    sha256Hex(req.body),
  ].join('\n');
}

export function sign(secret: string, req: SignableRequest): string {
  const mac = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(canonicalString(req))
    .digest('hex');
  return `${SIGNATURE_VERSION}=${mac}`;
}

export type VerifyFailure =
  | 'missing_headers'
  | 'bad_timestamp'
  | 'timestamp_out_of_range'
  | 'bad_signature_format'
  | 'signature_mismatch';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

/**
 * Verifies a signed request. `secret` is the decrypted client secret looked up
 * by key id; pass null for an unknown key id (a dummy comparison still runs
 * so unknown and wrong keys take the same time).
 */
export function verify(input: {
  secret: string | null;
  timestampHeader: string | null | undefined;
  signatureHeader: string | null | undefined;
  method: string;
  pathWithQuery: string;
  body: string | Uint8Array | null | undefined;
  now?: Date;
  toleranceSeconds?: number;
}): VerifyResult {
  const { timestampHeader, signatureHeader } = input;
  if (!timestampHeader || !signatureHeader) return { ok: false, reason: 'missing_headers' };
  if (!/^\d{9,11}$/.test(timestampHeader)) return { ok: false, reason: 'bad_timestamp' };

  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(timestampHeader)) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_range' };
  }

  const match = /^v1=([0-9a-f]{64})$/.exec(signatureHeader.trim());
  if (!match) return { ok: false, reason: 'bad_signature_format' };

  const expected = sign(input.secret ?? 'unknown-key-dummy-secret', {
    timestamp: timestampHeader,
    method: input.method,
    pathWithQuery: input.pathWithQuery,
    body: input.body,
  });
  const a = Buffer.from(expected.slice(3), 'hex');
  const b = Buffer.from(match[1]!, 'hex');
  const equal = a.length === b.length && timingSafeEqual(a, b);
  if (!equal || input.secret === null) return { ok: false, reason: 'signature_mismatch' };
  return { ok: true };
}

const BASE32 = 'abcdefghjkmnpqrstvwxyz0123456789';

function randomToken(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += BASE32[byte % BASE32.length];
  return out;
}

/** New credentials for an API client. The secret is shown once, then stored encrypted. */
export function generateApiCredentials(): { keyId: string; secret: string } {
  return {
    keyId: `kid_${randomToken(16)}`,
    secret: `sk_${randomBytes(32).toString('base64url')}`,
  };
}
