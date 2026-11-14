import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { deviceByToken, type TokenLookup } from '@pokeshop/core/devices';
import { accountEntitlements } from '@pokeshop/core/subscriptions';
import { db } from './config';
import { clientIp, rateLimited } from './rate-limit';

/** JSON error as in docs/app-account-api.md: { error, message, … }. */
export function apiError(
  status: number,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(
    { error, message, ...extra },
    { status, headers: { 'cache-control': 'no-store', ...headers } },
  );
}

export const ok = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });

const REASONS: Record<string, string> = {
  removed: 'This device was removed in the account.',
  transferred: 'This device was replaced by another one.',
  replaced: 'This device was connected again or to another account.',
  disconnected: 'This device was disconnected.',
};

/** The device behind "Authorization: Bearer …", or the 401 to send. */
export async function appAuth(
  req: NextRequest,
): Promise<Extract<TokenLookup, { ok: true }> | { ok: false; response: NextResponse }> {
  const h = req.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(\S+)$/i.exec(h)?.[1];
  const ip = clientIp(req.headers);
  if (rateLimited(`app:${ip}`, 600, 15 * 60_000)) {
    return {
      ok: false,
      response: apiError(429, 'rate_limited', 'Too many requests.', {}, { 'retry-after': '60' }),
    };
  }
  const r = await deviceByToken(db(), token, {
    appVersion: req.headers.get('x-app-version'),
  });
  if (r.ok) return r;
  if (r.problem === 'unpaired') {
    return {
      ok: false,
      response: apiError(401, 'unpaired', REASONS[r.reason] ?? 'This device was disconnected.', {
        reason: r.reason,
        since: r.since.toISOString(),
        device_name: r.successorName,
      }),
    };
  }
  return {
    ok: false,
    response: apiError(401, 'invalid_token', 'Missing or unknown device token.'),
  };
}

/** The JSON body, or null when it isn't a JSON object. */
export async function jsonBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Auth plus a subscription that includes the collection and missing cards (402 otherwise). */
export async function appPortal(
  req: NextRequest,
): Promise<Extract<TokenLookup, { ok: true }> | { ok: false; response: NextResponse }> {
  const a = await appAuth(req);
  if (!a.ok) return a;
  const ent = await accountEntitlements(db(), a.account);
  if (!ent.features.collection) {
    return {
      ok: false,
      response: apiError(402, 'subscription_required', 'The account has no running subscription.'),
    };
  }
  return a;
}

/** The app's language for names: the account's. */
export const appLocale = (a: { account: { locale: 'de' | 'en' } }) => a.account.locale;
