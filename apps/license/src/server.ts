import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import type { Sql } from '../../../packages/core/src/db.ts';
import {
  LicenseError,
  activate,
  check,
  findLicenses,
  issueLicenses,
  revoke,
  type LicenseView,
} from './store.ts';

/**
 * The license service's HTTP API.
 *
 * For the app (public, behind Caddy):
 *   GET  /health
 *   POST /v1/activate   {key, device_id, device_name?, app_version?} → {license_id, token, since}
 *   POST /v1/check      {token, app_version?} → {status: active | suspended | revoked, …}
 *
 * For the shop (Authorization: Bearer LICENSE_SHOP_TOKEN; not routed by Caddy, the shop
 * calls the container directly):
 *   POST /v1/shop/licenses                 {order_ref?, email?, name?, count?, note?} → {licenses: [...]}
 *   GET  /v1/shop/licenses?email=… | ?key=… → {licenses: [...]}
 *   GET  /v1/shop/licenses/{id}            → licence
 *   POST /v1/shop/licenses/{id}/revoke     {reason?} → {id, revoked_at}
 *
 * Errors: {error: <code>, message}. Keys and tokens are never logged.
 */

export type ServerOptions = {
  sql: Sql;
  masterKey: Buffer;
  shopToken: string;
  /** activations per client address and hour (key guessing is hopeless anyway; this keeps it quiet) */
  activateLimit?: number;
  log?: (msg: string) => void;
};

export function createLicenseServer(opts: ServerOptions): Server {
  const limiter = new RateLimiter(opts.activateLimit ?? 30, 60 * 60 * 1000);
  const log = opts.log ?? ((m: string) => console.log(m));
  return createServer((req, res) => {
    handle(req, res, opts, limiter).catch((e: unknown) => {
      if (e instanceof LicenseError)
        return send(res, e.status, { error: e.code, message: e.message });
      if (e instanceof BadRequest)
        return send(res, 400, { error: 'bad_request', message: e.message });
      log(`license: ${req.method} ${req.url?.split('?')[0]} failed: ${(e as Error).message}`);
      send(res, 500, { error: 'internal', message: 'internal error' });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions,
  limiter: RateLimiter,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://license');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  if (path === '/health' && method === 'GET') {
    await opts.sql`SELECT 1`;
    return send(res, 200, { ok: true });
  }

  if (path === '/v1/activate' && method === 'POST') {
    if (!limiter.take(clientAddress(req))) {
      return send(res, 429, { error: 'rate_limited', message: 'too many activations, try later' });
    }
    const b = await readJson(req);
    const a = await activate(opts.sql, str(b.key), {
      deviceId: str(b.device_id),
      deviceName: optStr(b.device_name),
      appVersion: optStr(b.app_version),
    });
    return send(res, 200, {
      license_id: a.licenseId,
      token: a.token,
      since: a.since.toISOString(),
    });
  }

  if (path === '/v1/check' && method === 'POST') {
    const b = await readJson(req);
    const r = await check(opts.sql, str(b.token), optStr(b.app_version));
    if (r.status === 'suspended') {
      return send(res, 200, {
        status: r.status,
        since: r.since.toISOString(),
        device_name: r.deviceName,
      });
    }
    return send(res, 200, { status: r.status });
  }

  if (path.startsWith('/v1/shop/')) {
    if (!authorized(req, opts.shopToken)) {
      return send(res, 401, { error: 'unauthorized', message: 'missing or wrong shop token' });
    }
    if (path === '/v1/shop/licenses' && method === 'POST') {
      const b = await readJson(req);
      const issued = await issueLicenses(opts.sql, opts.masterKey, {
        orderRef: optStr(b.order_ref),
        email: optStr(b.email),
        name: optStr(b.name),
        note: optStr(b.note),
        count: b.count === undefined ? 1 : Number(b.count),
      });
      const views = await findLicenses(opts.sql, opts.masterKey, {
        ids: issued.map((l) => l.id),
      });
      return send(res, issued.some((l) => l.created) ? 201 : 200, { licenses: views.map(json) });
    }
    if (path === '/v1/shop/licenses' && method === 'GET') {
      const email = url.searchParams.get('email');
      const key = url.searchParams.get('key');
      if (!email && !key) throw new BadRequest('email or key is required');
      const found = await findLicenses(opts.sql, opts.masterKey, email ? { email } : { key: key! });
      return send(res, 200, { licenses: found.map(json) });
    }
    const m = /^\/v1\/shop\/licenses\/(lic_[0-9a-z]{16})(\/revoke)?$/.exec(path);
    if (m && !m[2] && method === 'GET') {
      const [one] = await findLicenses(opts.sql, opts.masterKey, { ids: [m[1]!] });
      if (!one) return send(res, 404, { error: 'unknown_license', message: 'unknown licence' });
      return send(res, 200, json(one));
    }
    if (m && m[2] && method === 'POST') {
      const b = await readJson(req);
      const at = await revoke(opts.sql, m[1]!, optStr(b.reason) ?? 'revoked by the shop');
      return send(res, 200, { id: m[1], revoked_at: at.toISOString() });
    }
  }

  send(res, 404, { error: 'not_found', message: 'no such endpoint' });
}

/** A licence as the shop sees it; `qr` is the text to put into the licence's QR code. */
function json(l: LicenseView) {
  return {
    id: l.id,
    key: l.key,
    qr: l.key,
    email: l.email,
    name: l.name,
    order_ref: l.orderRef,
    note: l.note,
    created_at: l.createdAt.toISOString(),
    revoked_at: l.revokedAt?.toISOString() ?? null,
    revoke_reason: l.revokeReason,
    active_device: l.activeDevice
      ? {
          name: l.activeDevice.name,
          since: l.activeDevice.since.toISOString(),
          last_seen: l.activeDevice.lastSeen.toISOString(),
        }
      : null,
    activations: l.activations,
  };
}

class BadRequest extends Error {}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16 * 1024) throw new BadRequest('request body too large');
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new BadRequest('body must be a JSON object');
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function optStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m || !token) return false;
  const a = createHash('sha256').update(m[1]!).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

/** The caller's address: Caddy's X-Forwarded-For when present, else the socket. */
function clientAddress(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

/** A fixed window per address, kept in memory (one container). */
export class RateLimiter {
  private hits = new Map<string, { start: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  take(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { start: t, count: 1 });
      return true;
    }
    h.count += 1;
    return h.count <= this.limit;
  }
}
