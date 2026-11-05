import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts API client secrets at rest (AES-256-GCM). HMAC verification needs
 * the secret itself, so it cannot be stored as a one-way hash.
 * The master key comes from the environment (API_KEY_MASTER_KEY, 32 bytes, base64).
 * Format: v1.<iv>.<ciphertext>.<tag>, each part base64url.
 */

export function parseMasterKey(value: string | undefined): Buffer {
  if (!value) throw new Error('API_KEY_MASTER_KEY is not set');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('API_KEY_MASTER_KEY must be 32 bytes, base64-encoded');
  return key;
}

export function encryptSecret(plain: string, masterKey: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, ct, tag]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decryptSecret(stored: string, masterKey: Buffer): string {
  const [version, iv, ct, tag] = stored.split('.');
  if (version !== 'v1' || !iv || !ct || !tag) throw new Error('unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}
