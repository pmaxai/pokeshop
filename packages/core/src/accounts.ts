// Customer accounts. There is no password: the customer types an e-mail address, gets a one-time
// link (20 minutes, single use) and is logged in by it. The first login creates the account.
// Sessions are a random cookie token; only its hash is stored. Shop orders of the same address
// are linked to the account once the address is confirmed by a login link.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import type { Db, Sql } from './db.ts';
import { localePath } from './locale-paths.ts';
import { Address } from './orders.ts';
import { enqueueMail } from './outbox.ts';

export const LOGIN_LINK_MINUTES = 20;
export const SESSION_DAYS = 60;
/** Login links per address and hour; more are not sent (the page says the same). */
export const MAX_LINKS_PER_HOUR = 5;

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/** acc_ / dev_ + 10 random characters (51 bits). */
export function newPublicId(prefix: 'acc' | 'dev'): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return `${prefix}_${s}`;
}

export type Account = {
  id: number;
  publicId: string;
  email: string;
  name: string | null;
  phone: string | null;
  locale: 'de' | 'en';
  shippingAddress: Address | null;
  webshopHost: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  /** Goes with every app-store purchase (Google: obfuscatedAccountId, Apple: appAccountToken). */
  storeRef: string;
  /** Confirmed by a login link or an e-mail code. */
  emailVerified: boolean;
  signupVia: 'portal' | 'google' | 'apple' | 'email' | 'review';
};

type AccountRow = {
  id: number;
  public_id: string;
  email: string;
  name: string | null;
  phone: string | null;
  locale: 'de' | 'en';
  shipping_address: Address | null;
  webshop_host: string | null;
  created_at: Date;
  last_login_at: Date | null;
  store_ref: string;
  email_verified_at: Date | null;
  signup_via: Account['signupVia'];
};

export const ACCOUNT_COLUMNS =
  'id, public_id, email, name, phone, locale, shipping_address, webshop_host, created_at, last_login_at, store_ref, email_verified_at, signup_via';

export type { AccountRow };
export const toAccount = (r: AccountRow): Account => ({
  id: Number(r.id),
  publicId: r.public_id,
  email: r.email,
  name: r.name,
  phone: r.phone,
  locale: r.locale,
  shippingAddress: r.shipping_address,
  webshopHost: r.webshop_host,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
  storeRef: r.store_ref,
  emailVerified: r.email_verified_at !== null,
  signupVia: r.signup_via,
});

export async function accountById(db: Db, id: number): Promise<Account | null> {
  const [r] = await db<AccountRow[]>`
    SELECT ${db.unsafe(ACCOUNT_COLUMNS)} FROM accounts WHERE id = ${id}`;
  return r ? toAccount(r) : null;
}

export async function accountByPublicId(db: Db, publicId: string): Promise<Account | null> {
  if (!/^acc_[0-9a-z]{10}$/.test(publicId)) return null;
  const [r] = await db<AccountRow[]>`
    SELECT ${db.unsafe(ACCOUNT_COLUMNS)} FROM accounts WHERE public_id = ${publicId}`;
  return r ? toAccount(r) : null;
}

export async function accountByEmail(db: Db, email: string): Promise<Account | null> {
  const [r] = await db<AccountRow[]>`
    SELECT ${db.unsafe(ACCOUNT_COLUMNS)} FROM accounts WHERE email = ${email.trim().toLowerCase()}`;
  return r ? toAccount(r) : null;
}

// ---------------------------------------------------------------------------
// Login links
// ---------------------------------------------------------------------------

export const LoginRequest = z.object({
  email: z.string().trim().toLowerCase().max(200, 'too_long').pipe(z.email('invalid_email')),
});

/**
 * Where to go after logging in: a path of this site only (no "//host", no backslashes, no
 * control characters), else null.
 */
export function safeNextPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > 300) return null;
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;
  return p;
}

export const loginLinkUrl = (baseUrl: string, locale: 'de' | 'en', token: string) =>
  `${baseUrl}${localePath(locale, { de: '/anmelden/link', en: '/login/link' })}?t=${token}`;

/**
 * Sends a login link (queued mail). Returns 'throttled' when the address already got
 * MAX_LINKS_PER_HOUR links in the last hour: nothing is sent, but the page must answer the
 * same, so it can't be used to find out which addresses have accounts.
 */
export async function requestLoginLink(
  sql: Sql,
  input: {
    email: string;
    locale: 'de' | 'en';
    next?: string | null;
    ip?: string | null;
    baseUrl: string;
    now?: Date;
  },
): Promise<'sent' | 'throttled'> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  return sql.begin(async (tx) => {
    // one request at a time per address, so the limit can't be raced
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`login:${email}`}))`;
    const [c] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM account_login_links
       WHERE email = ${email} AND created_at > ${now}::timestamptz - interval '1 hour'`;
    if ((c?.n ?? 0) >= MAX_LINKS_PER_HOUR) return 'throttled';
    const token = newToken();
    const ip = input.ip && /^[0-9a-fA-F:.]{2,45}$/.test(input.ip) ? input.ip : null;
    const [l] = await tx<{ id: number }[]>`
      INSERT INTO account_login_links (token_hash, email, locale, next_path, ip, created_at, expires_at)
      VALUES (${tokenHash(token)}, ${email}, ${input.locale}, ${safeNextPath(input.next)},
              ${ip}::inet, ${now},
              ${now}::timestamptz + make_interval(mins => ${LOGIN_LINK_MINUTES}))
      RETURNING id`;
    const exists = await accountByEmail(tx, email);
    await enqueueMail(tx, {
      template: 'account_login',
      to: email,
      locale: input.locale,
      payload: {
        url: loginLinkUrl(input.baseUrl, input.locale, token),
        minutes: LOGIN_LINK_MINUTES,
        new_account: !exists,
      },
      dedupeKey: `account_login:${l!.id}`,
    });
    return 'sent';
  });
}

/** The verification link of an account made in the app works this long. */
export const VERIFY_LINK_DAYS = 7;

/**
 * For an account made in the app: a link that confirms the address and logs in to the portal
 * (the subscription works before it is used). Sent once per new account, and again on request.
 */
export async function sendVerificationLink(
  db: Db,
  account: Pick<Account, 'id' | 'email' | 'locale' | 'emailVerified'>,
  opts: { baseUrl: string; now?: Date; again?: boolean },
): Promise<'sent' | 'throttled'> {
  const now = opts.now ?? new Date();
  const [c] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM account_login_links
     WHERE email = ${account.email} AND created_at > ${now}::timestamptz - interval '1 hour'`;
  if ((c?.n ?? 0) >= MAX_LINKS_PER_HOUR) return 'throttled';
  const token = newToken();
  const next = localePath(account.locale, { de: '/konto', en: '/account' });
  const [l] = await db<{ id: number }[]>`
    INSERT INTO account_login_links (token_hash, email, locale, next_path, created_at, expires_at)
    VALUES (${tokenHash(token)}, ${account.email}, ${account.locale}, ${next}, ${now},
            ${now}::timestamptz + make_interval(days => ${VERIFY_LINK_DAYS}))
    RETURNING id`;
  await enqueueMail(db, {
    template: 'account_verify',
    to: account.email,
    locale: account.locale,
    payload: {
      url: loginLinkUrl(opts.baseUrl, account.locale, token),
      days: VERIFY_LINK_DAYS,
      verified: account.emailVerified,
      again: Boolean(opts.again),
    },
    dedupeKey: `account_verify:${l!.id}`,
  });
  return 'sent';
}

export type LinkProblem = 'invalid' | 'expired' | 'used';

/** What a link is, without using it (the page shows "Log in as …"). */
export async function peekLoginLink(
  db: Db,
  token: string,
  now = new Date(),
): Promise<{ ok: true; email: string } | { ok: false; problem: LinkProblem }> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, problem: 'invalid' };
  const [l] = await db<{ email: string; expires_at: Date; used_at: Date | null }[]>`
    SELECT email, expires_at, used_at FROM account_login_links WHERE token_hash = ${tokenHash(token)}`;
  if (!l) return { ok: false, problem: 'invalid' };
  if (l.used_at) return { ok: false, problem: 'used' };
  if (l.expires_at <= now) return { ok: false, problem: 'expired' };
  return { ok: true, email: l.email };
}

/**
 * Uses a login link: creates the account on the first login, links earlier orders of the
 * address and returns where to go next.
 */
export async function redeemLoginLink(
  sql: Sql,
  token: string,
  now = new Date(),
): Promise<
  | { ok: true; account: Account; next: string | null; created: boolean }
  | { ok: false; problem: LinkProblem }
> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, problem: 'invalid' };
  const r = await sql.begin(async (tx) => {
    const [l] = await tx<{ email: string; locale: 'de' | 'en'; next_path: string | null }[]>`
      UPDATE account_login_links SET used_at = ${now}
       WHERE token_hash = ${tokenHash(token)} AND used_at IS NULL AND expires_at > ${now}
      RETURNING email, locale, next_path`;
    if (!l) return null;
    const [a] = await tx<(AccountRow & { created: boolean })[]>`
      INSERT INTO accounts (public_id, email, locale, last_login_at, email_verified_at)
      VALUES (${newPublicId('acc')}, ${l.email}, ${l.locale}, ${now}, ${now})
      ON CONFLICT (email) DO UPDATE SET last_login_at = EXCLUDED.last_login_at,
        email_verified_at = coalesce(accounts.email_verified_at, EXCLUDED.email_verified_at)
      RETURNING ${tx.unsafe(ACCOUNT_COLUMNS)}, (xmax = 0) AS created`;
    await linkOrdersByEmail(tx, Number(a!.id), l.email);
    return { account: toAccount(a!), next: l.next_path, created: Boolean(a!.created) };
  });
  if (r) return { ok: true, ...r };
  const peek = await peekLoginLink(sql, token, now);
  return { ok: false, problem: peek.ok ? 'invalid' : peek.problem };
}

/** Earlier orders of the address (placed as a guest) belong to the account from now on. */
export async function linkOrdersByEmail(db: Db, accountId: number, email: string): Promise<number> {
  const r = await db`
    UPDATE orders SET account_id = ${accountId}
     WHERE account_id IS NULL AND lower(email) = ${email.toLowerCase()}
       AND status NOT IN ('checkout', 'expired', 'payment_failed')`;
  return r.count;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createAccountSession(
  db: Db,
  accountId: number,
  meta: { ip?: string | null; userAgent?: string | null; now?: Date } = {},
): Promise<string> {
  const now = meta.now ?? new Date();
  const token = newToken();
  const ip = meta.ip && /^[0-9a-fA-F:.]{2,45}$/.test(meta.ip) ? meta.ip : null;
  await db`
    INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at, last_seen_at, ip, user_agent)
    VALUES (${tokenHash(token)}, ${accountId}, ${now},
            ${now}::timestamptz + make_interval(days => ${SESSION_DAYS}), ${now}, ${ip}::inet,
            ${meta.userAgent?.slice(0, 300) ?? null})`;
  return token;
}

/** The session's account; each visit moves the expiry SESSION_DAYS ahead. */
export async function sessionAccount(
  db: Db,
  token: string | undefined | null,
  now = new Date(),
): Promise<Account | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [r] = await db<AccountRow[]>`
    WITH s AS (
      UPDATE account_sessions
         SET last_seen_at = ${now},
             expires_at = ${now}::timestamptz + make_interval(days => ${SESSION_DAYS})
       WHERE token_hash = ${tokenHash(token)} AND expires_at > ${now}
      RETURNING account_id)
    SELECT ${db.unsafe(ACCOUNT_COLUMNS.replace(/(^|, )/g, '$1a.'))}
      FROM s JOIN accounts a ON a.id = s.account_id`;
  return r ? toAccount(r) : null;
}

export async function endAccountSession(db: Db, token: string): Promise<void> {
  await db`DELETE FROM account_sessions WHERE token_hash = ${tokenHash(token)}`;
}

/** Old links and sessions (worker). */
export async function deleteExpiredLogins(db: Db, now = new Date()): Promise<number> {
  const a = await db`
    DELETE FROM account_login_links WHERE created_at < ${now}::timestamptz - interval '7 days'`;
  const b = await db`DELETE FROM account_sessions WHERE expires_at < ${now}`;
  // the app's e-mail codes are valid 10 minutes; kept a day for the hourly limit
  const c = await db`
    DELETE FROM app_login_codes WHERE created_at < ${now}::timestamptz - interval '1 day'`;
  return a.count + b.count + c.count;
}

// ---------------------------------------------------------------------------
// Profile and address
// ---------------------------------------------------------------------------

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'too_long')
    .transform((v) => v || null)
    .optional();

export const Profile = z.object({
  name: optional(100),
  phone: optional(40),
  locale: z.enum(['de', 'en'], 'invalid'),
});
export type Profile = z.infer<typeof Profile>;

const issuesToErrors = (issues: z.core.$ZodIssue[]) => {
  const errors: Record<string, string> = {};
  for (const i of issues) {
    const k = i.path.join('.') || '_';
    errors[k] ??= i.message.startsWith('Invalid') ? 'invalid' : i.message;
  }
  return errors;
};

export async function saveProfile(
  db: Db,
  accountId: number,
  input: unknown,
): Promise<{ ok: true } | { ok: false; errors: Record<string, string> }> {
  const r = Profile.safeParse(input);
  if (!r.success) return { ok: false, errors: issuesToErrors(r.error.issues) };
  await db`
    UPDATE accounts SET name = ${r.data.name ?? null}, phone = ${r.data.phone ?? null},
                        locale = ${r.data.locale}
     WHERE id = ${accountId}`;
  return { ok: true };
}

/** Saves (or with null clears) the default shipping address. */
export async function saveShippingAddress(
  db: Db,
  accountId: number,
  input: unknown,
): Promise<{ ok: true; address: Address | null } | { ok: false; errors: Record<string, string> }> {
  if (input === null) {
    await db`UPDATE accounts SET shipping_address = NULL WHERE id = ${accountId}`;
    return { ok: true, address: null };
  }
  const r = Address.safeParse(input);
  if (!r.success) return { ok: false, errors: issuesToErrors(r.error.issues) };
  const [c] = await db<{ code: string }[]>`
    SELECT code FROM countries WHERE code = ${r.data.country} AND delivery_enabled`;
  if (!c) return { ok: false, errors: { country: 'country' } };
  await db`UPDATE accounts SET shipping_address = ${db.json(r.data as never)} WHERE id = ${accountId}`;
  return { ok: true, address: r.data };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type AccountOrder = {
  number: string;
  token: string;
  status: string;
  kind: 'cards' | 'license' | 'voucher';
  createdAt: Date;
  totalCents: number;
  items: number;
};

export async function accountOrders(
  db: Db,
  accountId: number,
  limit = 100,
): Promise<AccountOrder[]> {
  const rows = await db<
    {
      number: string;
      lookup_token: string;
      status: string;
      kind: AccountOrder['kind'];
      created_at: Date;
      total_cents: number;
      items: number;
    }[]
  >`
    SELECT o.number, o.lookup_token, o.status, o.kind, o.created_at, o.total_cents,
           coalesce((SELECT sum(quantity)::int FROM order_items i WHERE i.order_id = o.id), 0) AS items
      FROM orders o
     WHERE o.account_id = ${accountId} AND o.status NOT IN ('checkout', 'expired', 'payment_failed')
     ORDER BY o.created_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    number: r.number,
    token: r.lookup_token,
    status: r.status,
    kind: r.kind,
    createdAt: r.created_at,
    totalCents: Number(r.total_cents),
    items: Number(r.items),
  }));
}

/** Days a deleted account's scrubbed row stays (devices learn why; store renewals stop). */
export const DELETED_KEEP_DAYS = 30;

/**
 * Deletes the account: its sign-ins end at once (devices answer unpaired / account_deleted),
 * collection, missing cards, shares, sign-in identities and the S3 settings go, the address and
 * name are removed. A running app-store subscription is marked to stop renewing (the worker
 * tells the store). Orders and invoices stay: they are the shop's records. The scrubbed row is
 * removed after DELETED_KEEP_DAYS. Returns the store subscriptions that must be cancelled by
 * the customer themselves (App Store), if any.
 */
export async function deleteAccount(
  sql: Sql,
  accountId: number,
  now = new Date(),
): Promise<{ deleted: boolean; cancelInStore: { store: string; productId: string }[] }> {
  return sql.begin(async (tx) => {
    const [a] = await tx<{ email: string; public_id: string; deleted_at: Date | null }[]>`
      SELECT email, public_id, deleted_at FROM accounts WHERE id = ${accountId} FOR UPDATE`;
    if (!a || a.deleted_at) return { deleted: false, cancelInStore: [] };
    await tx`
      UPDATE devices SET ended_at = ${now}, end_reason = 'account_deleted'
       WHERE account_id = ${accountId} AND ended_at IS NULL`;
    await tx`DELETE FROM account_sessions WHERE account_id = ${accountId}`;
    await tx`DELETE FROM account_login_links WHERE email = ${a.email}`;
    await tx`DELETE FROM app_login_codes WHERE email = ${a.email}`;
    await tx`DELETE FROM account_identities WHERE account_id = ${accountId}`;
    await tx`DELETE FROM pairing_codes WHERE account_id = ${accountId}`;
    await tx`DELETE FROM collection_shares WHERE account_id = ${accountId}`;
    await tx`DELETE FROM collection_items WHERE account_id = ${accountId}`;
    await tx`DELETE FROM collection_binders WHERE account_id = ${accountId}`;
    await tx`DELETE FROM wanted_cards WHERE account_id = ${accountId}`;
    await tx`DELETE FROM account_services WHERE account_id = ${accountId}`;
    const running = await tx<{ store: string; product_id: string }[]>`
      UPDATE store_purchases SET cancel_requested_at = ${now}
       WHERE account_id = ${accountId} AND replaced_by IS NULL AND auto_renew
         AND state IN ('active', 'canceled', 'grace', 'on_hold', 'paused')
       RETURNING store, product_id`;
    await tx`
      UPDATE accounts SET deleted_at = ${now}, email = ${`deleted-${a.public_id}@deleted.invalid`},
             name = NULL, phone = NULL, shipping_address = NULL, webshop_host = NULL,
             admin_note = NULL, email_verified_at = NULL, billing = NULL
       WHERE id = ${accountId}`;
    return {
      deleted: true,
      cancelInStore: running
        .filter((r) => r.store === 'app_store')
        .map((r) => ({ store: r.store, productId: r.product_id })),
    };
  });
}

/**
 * Removes deleted accounts after DELETED_KEEP_DAYS (worker) – later only while a cancelled
 * website subscription still runs, a store renewal is not stopped yet or usage is still to be
 * billed. Store purchases outlive the account without it, for seven years.
 */
export async function purgeDeletedAccounts(db: Db, now = new Date()): Promise<number> {
  const r = await db`
    DELETE FROM accounts a
     WHERE a.deleted_at < ${now}::timestamptz - make_interval(days => ${DELETED_KEEP_DAYS})
       AND NOT EXISTS (SELECT 1 FROM subscriptions s
                        WHERE s.account_id = a.id AND s.source = 'stripe' AND s.ended_at IS NULL
                          AND s.current_period_end > ${now})
       AND NOT EXISTS (SELECT 1 FROM store_purchases p
                        WHERE p.account_id = a.id AND p.cancel_requested_at IS NOT NULL
                          AND p.cancelled_at_store IS NULL
                          AND p.state NOT IN ('expired', 'revoked'))
       AND NOT EXISTS (SELECT 1 FROM device_subscriptions d
                        WHERE d.account_id = a.id AND d.ended_at IS NULL
                          AND d.status IN ('active', 'trialing', 'past_due')
                          AND d.current_period_end > ${now})
       AND NOT EXISTS (SELECT 1 FROM usage_events u
                        WHERE u.account_id = a.id AND u.billing = 'queued')`;
  await db`
    DELETE FROM store_purchases
     WHERE account_id IS NULL AND updated_at < ${now}::timestamptz - interval '7 years'`;
  return r.count;
}
