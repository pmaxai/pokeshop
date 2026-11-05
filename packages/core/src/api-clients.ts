import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import { isPgError, SQLSTATE } from './db.ts';
import { decryptSecret, encryptSecret } from './secrets.ts';
import { generateApiCredentials } from './signing.ts';

export const API_SCOPES = ['products:read', 'products:write', 'stock:write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export type ApiClient = {
  id: number;
  name: string;
  key_id: string;
  scopes: ApiScope[];
  ip_allowlist: string[];
  rate_limit_per_minute: number;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

/** Creates an API client. The secret is returned once and only stored encrypted. */
export async function createApiClient(
  db: Db,
  input: { name: string; scopes?: ApiScope[]; ipAllowlist?: string[]; createdBy: string },
  masterKey: Buffer,
): Promise<{ client: ApiClient; secret: string }> {
  const { keyId, secret } = generateApiCredentials();
  const [client] = await db<ApiClient[]>`
    INSERT INTO api_clients (name, key_id, secret_enc, scopes, ip_allowlist, created_by)
    VALUES (${input.name}, ${keyId}, ${encryptSecret(secret, masterKey)},
            ${input.scopes ?? [...API_SCOPES]}::text[], ${input.ipAllowlist ?? []}::cidr[], ${input.createdBy})
    RETURNING id, name, key_id, scopes, ip_allowlist::text[] AS ip_allowlist, rate_limit_per_minute,
              created_at, last_used_at, revoked_at`;
  return { client: client!, secret };
}

export async function listApiClients(db: Db): Promise<ApiClient[]> {
  return [
    ...(await db<ApiClient[]>`
      SELECT id, name, key_id, scopes, ip_allowlist::text[] AS ip_allowlist, rate_limit_per_minute,
             created_at, last_used_at, revoked_at
        FROM api_clients ORDER BY revoked_at NULLS FIRST, created_at DESC`),
  ];
}

export async function revokeApiClient(db: Db, id: number): Promise<void> {
  await db`UPDATE api_clients SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL`;
}

/** Looks up a client by key id and decrypts its secret for signature checks. */
export async function loadApiClient(
  db: Db,
  keyId: string,
  masterKey: Buffer,
): Promise<(ApiClient & { secret: string }) | null> {
  const [row] = await db<(ApiClient & { secret_enc: string })[]>`
    SELECT id, name, key_id, secret_enc, scopes, ip_allowlist::text[] AS ip_allowlist,
           rate_limit_per_minute, created_at, last_used_at, revoked_at
      FROM api_clients WHERE key_id = ${keyId}`;
  if (!row) return null;
  const { secret_enc, ...client } = row;
  return { ...client, secret: decryptSecret(secret_enc, masterKey) };
}

/** Records use at most once a minute per client. */
export async function touchApiClient(db: Db, id: number): Promise<void> {
  await db`UPDATE api_clients SET last_used_at = now()
            WHERE id = ${id} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`;
}

/** Is the IP inside one of the client's networks? An empty list allows every address. */
export async function ipAllowed(db: Db, clientId: number, ip: string | null): Promise<boolean> {
  const [r] = await db<{ ok: boolean }[]>`
    SELECT cardinality(ip_allowlist) = 0
           OR (${ip}::inet IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(ip_allowlist) n WHERE ${ip}::inet <<= n)) AS ok
      FROM api_clients WHERE id = ${clientId}`;
  return r?.ok ?? false;
}

export function requestHash(method: string, path: string, body: string | Uint8Array): string {
  return createHash('sha256')
    .update(method)
    .update('\n')
    .update(path)
    .update('\n')
    .update(body)
    .digest('hex');
}

export type IdempotencyState =
  | { state: 'new' }
  | { state: 'replay'; status: number; body: unknown }
  | { state: 'conflict' }
  | { state: 'in_progress' };

/**
 * Claims an Idempotency-Key before the request runs. A repeat within 24 h
 * returns the stored response; the same key with another body is a conflict.
 */
export async function claimIdempotencyKey(
  db: Db,
  clientId: number,
  key: string,
  hash: string,
): Promise<IdempotencyState> {
  await db`DELETE FROM api_idempotency WHERE client_id = ${clientId} AND idempotency_key = ${key}
             AND created_at < now() - interval '24 hours'`;
  try {
    await db`INSERT INTO api_idempotency (client_id, idempotency_key, request_hash, status_code, response)
             VALUES (${clientId}, ${key}, ${hash}, 0, '{}')`;
    return { state: 'new' };
  } catch (e) {
    if (!isPgError(e, SQLSTATE.uniqueViolation)) throw e;
  }
  const [row] = await db<{ request_hash: string; status_code: number; response: unknown }[]>`
    SELECT request_hash, status_code, response FROM api_idempotency
     WHERE client_id = ${clientId} AND idempotency_key = ${key}`;
  if (!row) return { state: 'in_progress' };
  if (row.request_hash !== hash) return { state: 'conflict' };
  if (row.status_code === 0) return { state: 'in_progress' };
  return { state: 'replay', status: row.status_code, body: row.response };
}

export async function storeIdempotentResponse(
  db: Db,
  clientId: number,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  await db`UPDATE api_idempotency SET status_code = ${status}, response = ${db.json(body as never)}
            WHERE client_id = ${clientId} AND idempotency_key = ${key}`;
}

/** Server errors are not stored, so the client can retry with the same key. */
export async function releaseIdempotencyKey(db: Db, clientId: number, key: string): Promise<void> {
  await db`DELETE FROM api_idempotency WHERE client_id = ${clientId} AND idempotency_key = ${key}`;
}

export async function logApiRequest(
  db: Db,
  r: {
    clientId: number | null;
    keyId: string | null;
    method: string;
    path: string;
    status: number;
    error: string | null;
    ms: number;
    ip: string | null;
  },
): Promise<void> {
  await db`INSERT INTO api_request_log (client_id, key_id, method, path, status_code, error_code, duration_ms, ip)
           VALUES (${r.clientId}, ${r.keyId}, ${r.method}, ${r.path.slice(0, 500)}, ${r.status}, ${r.error},
                   ${r.ms}, ${r.ip}::inet)`;
}
