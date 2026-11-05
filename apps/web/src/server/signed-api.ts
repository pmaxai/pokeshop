import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { verify } from '@pokeshop/core/signing';
import { ApiError } from '@pokeshop/core/errors';
import {
  claimIdempotencyKey,
  ipAllowed,
  loadApiClient,
  logApiRequest,
  releaseIdempotencyKey,
  requestHash,
  storeIdempotentResponse,
  touchApiClient,
  type ApiClient,
  type ApiScope,
} from '@pokeshop/core/api-clients';
import type { Actor, ProductOptions } from '@pokeshop/core/products';
import { apiMasterKey, config, db, tcgdexClient } from './config';

export type SignedContext = {
  req: NextRequest;
  raw: Buffer;
  /** Parsed JSON body (undefined for GET and multipart). */
  json: unknown;
  client: ApiClient;
  actor: Actor;
  params: Record<string, string>;
  options: ProductOptions;
};

export type HandlerResult = { status: number; body: unknown };

/** Simple per-key, per-minute window; one web container serves the API. */
const windows = new Map<string, { start: number; count: number }>();
function rateLimited(keyId: string, limit: number): number | null {
  const now = Date.now();
  const w = windows.get(keyId);
  if (!w || now - w.start >= 60_000) {
    windows.set(keyId, { start: now, count: 1 });
    return null;
  }
  w.count++;
  return w.count > limit ? Math.ceil((w.start + 60_000 - now) / 1000) : null;
}

function clientIp(req: NextRequest): string | null {
  // Caddy replaces X-Forwarded-For from untrusted clients, so the first entry is the client.
  const xff = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return xff && /^[0-9a-fA-F:.]+$/.test(xff) ? xff : null;
}

function json(status: number, body: unknown, headers?: Record<string, string>) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

/**
 * Wraps a route handler of the scanning-app API: checks the HMAC signature,
 * key, scope, IP allow-list and rate limit; replays repeated Idempotency-Keys;
 * logs every request; turns ApiErrors into JSON responses.
 */
export function signed(
  scope: ApiScope,
  handler: (ctx: SignedContext) => Promise<HandlerResult>,
  opts: { maxBody?: number } = {},
) {
  return async (req: NextRequest, route: { params: Promise<Record<string, string>> }) => {
    const started = Date.now();
    const url = new URL(req.url);
    const pathWithQuery = url.pathname + url.search;
    const ip = clientIp(req);
    const keyId = req.headers.get('x-key-id');
    let client: (ApiClient & { secret: string }) | null = null;
    let status = 500;
    let error: string | null = null;
    let idem: { key: string } | null = null;

    const respond = (s: number, body: unknown, headers?: Record<string, string>) => {
      status = s;
      error = s >= 400 ? ((body as { error?: string })?.error ?? 'error') : null;
      return json(s, body, headers);
    };

    try {
      const maxBody = opts.maxBody ?? 2 * 1024 * 1024;
      const declared = Number(req.headers.get('content-length') ?? 0);
      if (declared > maxBody)
        throw new ApiError(413, 'too_large', `body larger than ${maxBody} bytes`);
      const raw = req.method === 'GET' ? Buffer.alloc(0) : Buffer.from(await req.arrayBuffer());
      if (raw.length > maxBody)
        throw new ApiError(413, 'too_large', `body larger than ${maxBody} bytes`);

      client = keyId ? await loadApiClient(db(), keyId, apiMasterKey()) : null;
      const check = verify({
        secret: client?.secret ?? null,
        timestampHeader: req.headers.get('x-timestamp'),
        signatureHeader: req.headers.get('x-signature'),
        method: req.method,
        pathWithQuery,
        body: raw,
      });
      if (!check.ok) throw new ApiError(401, check.reason);
      if (!client) throw new ApiError(401, 'signature_mismatch');
      if (client.revoked_at) throw new ApiError(403, 'key_revoked');
      if (!client.scopes.includes(scope))
        throw new ApiError(403, 'scope_missing', `needs ${scope}`);
      if (!(await ipAllowed(db(), client.id, ip))) throw new ApiError(403, 'ip_not_allowed');
      const retryAfter = rateLimited(client.key_id, client.rate_limit_per_minute);
      if (retryAfter !== null) {
        return respond(429, { error: 'rate_limited' }, { 'Retry-After': String(retryAfter) });
      }
      void touchApiClient(db(), client.id).catch(() => {});

      if (req.method !== 'GET') {
        const key = req.headers.get('idempotency-key')?.trim();
        if (!key || key.length > 100) {
          throw new ApiError(
            400,
            'idempotency_key_missing',
            'writes need an Idempotency-Key header',
          );
        }
        const state = await claimIdempotencyKey(
          db(),
          client.id,
          key,
          requestHash(req.method, pathWithQuery, raw),
        );
        if (state.state === 'replay')
          return respond(state.status, state.body, { 'Idempotent-Replayed': 'true' });
        if (state.state === 'conflict')
          throw new ApiError(409, 'idempotency_conflict', 'key reused with a different request');
        if (state.state === 'in_progress')
          throw new ApiError(
            409,
            'idempotency_in_progress',
            'the first request with this key is still running',
          );
        idem = { key };
      }

      let body: unknown;
      const type = req.headers.get('content-type') ?? '';
      if (raw.length && type.includes('application/json')) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new ApiError(400, 'bad_json', 'body is not valid JSON');
        }
      }

      const result = await handler({
        req,
        raw,
        json: body,
        client,
        actor: { source: 'api', id: client.key_id, reference: idem ? `idem:${idem.key}` : null },
        params: await route.params,
        options: {
          tcgdex: tcgdexClient(),
          baseUrl: config.baseUrl,
        },
      });
      if (idem)
        await storeIdempotentResponse(db(), client.id, idem.key, result.status, result.body);
      return respond(result.status, result.body);
    } catch (e) {
      if (e instanceof ApiError) {
        if (idem && client)
          await storeIdempotentResponse(db(), client.id, idem.key, e.status, e.toJSON()).catch(
            () => {},
          );
        return respond(e.status, e.toJSON());
      }
      console.error('[api]', req.method, pathWithQuery, e);
      if (idem && client) await releaseIdempotencyKey(db(), client.id, idem.key).catch(() => {});
      return respond(500, {
        error: 'internal',
        message: 'unexpected error; safe to retry with the same Idempotency-Key',
      });
    } finally {
      void logApiRequest(db(), {
        clientId: client?.id ?? null,
        keyId,
        method: req.method,
        path: pathWithQuery,
        status,
        error,
        ms: Date.now() - started,
        ip,
      }).catch(() => {});
    }
  };
}
