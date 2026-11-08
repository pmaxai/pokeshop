export const LICENSE_MIGRATIONS_DIR = new URL('../migrations/', import.meta.url).pathname;

/** LICENSE_MASTER_KEY: 32 bytes, base64. Encrypts the stored licence keys. */
export function licenseMasterKey(value = process.env.LICENSE_MASTER_KEY): Buffer {
  if (!value) throw new Error('LICENSE_MASTER_KEY is not set');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('LICENSE_MASTER_KEY must be 32 bytes, base64-encoded');
  return key;
}
