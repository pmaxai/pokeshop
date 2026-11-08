import { createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * Licence keys: "CS-" and four groups of five characters from Crockford's base32
 * (no I, L, O, U), 100 random bits. The QR code holds the key as it is printed.
 * Typed keys are forgiving: case, spaces and dashes don't matter, O reads as 0, I and L as 1.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const KEY_PREFIX = 'CS';
const BODY = 20;

export function generateKey(): string {
  let body = '';
  for (let i = 0; i < BODY; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return formatKey(body);
}

/** "CS-XXXXX-XXXXX-XXXXX-XXXXX" from the 20 characters. */
export function formatKey(body: string): string {
  return [KEY_PREFIX, ...(body.match(/.{5}/g) ?? [])].join('-');
}

/** The 20 characters of a key as typed or scanned, or null if it can't be one. */
export function normalizeKey(input: string): string | null {
  let s = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length === BODY + KEY_PREFIX.length && s.startsWith(KEY_PREFIX))
    s = s.slice(KEY_PREFIX.length);
  if (s.length !== BODY) return null;
  for (const c of s) if (!ALPHABET.includes(c)) return null;
  return s;
}

export function keyHash(body: string): Buffer {
  return createHash('sha256').update(body).digest();
}

/** The last group, to tell keys apart in support without showing them. */
export function keyHint(body: string): string {
  return body.slice(-5);
}

/** A device's proof of its activation: random, only its hash is stored. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function newLicenseId(): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `lic_${s.toLowerCase()}`;
}
