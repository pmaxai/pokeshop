/**
 * The shop's side of the licence service (apps/license, docs/license-service.md): issue keys
 * after payment, look them up to send them again, revoke them on a refund. The service runs in
 * the same stack and is reached at LICENSE_SERVICE_URL with LICENSE_SHOP_TOKEN.
 */

export type License = {
  id: string;
  key: string;
  /** Text for the QR code the app scans (the key itself). */
  qr: string;
  email: string | null;
  name: string | null;
  order_ref: string | null;
  note: string | null;
  created_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  active_device: { name: string | null; since: string; last_seen: string | null } | null;
  activations: number;
};

export interface LicenseClient {
  /** Idempotent per order: a retry returns the licences the order already has. */
  issue(input: {
    orderRef: string;
    email: string;
    name: string;
    count: number;
  }): Promise<License[]>;
  byEmail(email: string): Promise<License[]>;
  get(id: string): Promise<License | null>;
  revoke(id: string, reason: string): Promise<void>;
}

export class LicenseServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function httpLicenseClient(opts: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): LicenseClient {
  const base = opts.baseUrl.replace(/\/$/, '');
  const doFetch = opts.fetch ?? fetch;
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: reported below
    }
    if (!res.ok) {
      const e = (data ?? {}) as { error?: string; message?: string };
      throw new LicenseServiceError(
        res.status,
        e.error ?? 'http_error',
        `licence service ${method} ${path}: ${res.status} ${e.message ?? e.error ?? text.slice(0, 200)}`,
      );
    }
    return data as T;
  }
  return {
    async issue(input) {
      const r = await call<{ licenses: License[] }>('POST', '/v1/shop/licenses', {
        order_ref: input.orderRef,
        email: input.email,
        name: input.name,
        count: input.count,
      });
      return r.licenses;
    },
    async byEmail(email) {
      const r = await call<{ licenses: License[] }>(
        'GET',
        `/v1/shop/licenses?email=${encodeURIComponent(email)}`,
      );
      return r.licenses;
    },
    async get(id) {
      try {
        return await call<License>('GET', `/v1/shop/licenses/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e instanceof LicenseServiceError && e.status === 404) return null;
        throw e;
      }
    },
    async revoke(id, reason) {
      await call('POST', `/v1/shop/licenses/${encodeURIComponent(id)}/revoke`, { reason });
    },
  };
}

/** The client when LICENSE_SERVICE_URL and LICENSE_SHOP_TOKEN are set, otherwise null. */
export function licenseClientFromEnv(env: NodeJS.ProcessEnv = process.env): LicenseClient | null {
  const baseUrl = env.LICENSE_SERVICE_URL?.trim();
  const token = env.LICENSE_SHOP_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  return httpLicenseClient({ baseUrl, token });
}

/** In-memory stand-in for tests. */
export function memoryLicenseClient(): LicenseClient & { all(): License[] } {
  const items: License[] = [];
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const group = () =>
    Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * 32)]).join('');
  return {
    all: () => items,
    async issue(input) {
      const existing = items.filter((l) => l.order_ref === input.orderRef);
      if (existing.length) {
        if (existing.length !== input.count) {
          throw new LicenseServiceError(409, 'order_mismatch', 'order has other licences');
        }
        return existing;
      }
      for (let i = 0; i < input.count; i++) {
        const key = `CS-${group()}-${group()}-${group()}-${group()}`;
        items.push({
          id: `lic_${Math.random().toString(16).slice(2, 18).padEnd(16, '0')}`,
          key,
          qr: key,
          email: input.email.toLowerCase(),
          name: input.name,
          order_ref: input.orderRef,
          note: null,
          created_at: new Date().toISOString(),
          revoked_at: null,
          revoke_reason: null,
          active_device: null,
          activations: 0,
        });
      }
      return items.filter((l) => l.order_ref === input.orderRef);
    },
    async byEmail(email) {
      return items.filter((l) => l.email === email.trim().toLowerCase());
    },
    async get(id) {
      return items.find((l) => l.id === id) ?? null;
    },
    async revoke(id, reason) {
      const l = items.find((x) => x.id === id);
      if (!l) throw new LicenseServiceError(404, 'unknown_license', 'no such licence');
      if (!l.revoked_at) {
        l.revoked_at = new Date().toISOString();
        l.revoke_reason = reason;
      }
    },
  };
}
