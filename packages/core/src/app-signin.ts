// Signing in from the app, for customers who buy the subscription in an app store: "Continue
// with Google" (an ID token from the phone's Google account), "Sign in with Apple" (an identity
// token from the iPhone) or "Use another email" (a 6-digit code by e-mail). The account is created on the first sign-in, before anything is bought, and
// gets a device token like pairing does. New accounts get an e-mail with a link that confirms
// the address and logs in to the portal. See docs/app-account-api.md.
import { createHash, randomInt } from 'node:crypto';
import type { Db, Sql } from './db.ts';
import {
  ACCOUNT_COLUMNS,
  LoginRequest,
  newPublicId,
  sendVerificationLink,
  toAccount,
  type Account,
  type AccountRow,
} from './accounts.ts';
import { registerDevice, type Device, type PairInput } from './devices.ts';
import { enqueueMail } from './outbox.ts';
import { JwtError, verifyJwt, type KeyLookup } from './jwt.ts';
import { APPLE_ISSUER, revokeAppleToken, type AppleSignInKey } from './apple.ts';
import { decryptSecret } from './secrets.ts';

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export const CODE_MINUTES = 10;
export const CODE_TRIES = 5;
export const CODES_PER_HOUR = 5;
export const CODE_RESEND_SECONDS = 60;
/** Staging: addresses here accept the code 000000 (test hooks only). */
export const TEST_EMAIL_DOMAIN = '@test.overpricedcardboard.com';
export const TEST_CODE = '000000';

export type Identity = {
  provider: 'google' | 'apple';
  subject: string;
  email: string | null;
  name: string | null;
};

/**
 * Checks a Google ID token ("Continue with Google" in the app): Google's signature, issuer,
 * audience (the app's OAuth client ids) and a confirmed e-mail address.
 */
export async function verifyGoogleIdToken(
  token: string,
  opts: { audiences: string[]; keys: KeyLookup; now?: Date },
): Promise<Identity> {
  const c = await verifyJwt(token, {
    keys: opts.keys,
    issuers: GOOGLE_ISSUERS,
    audiences: opts.audiences,
    now: opts.now,
  });
  const sub = typeof c.sub === 'string' ? c.sub : '';
  const email = typeof c.email === 'string' ? c.email.trim().toLowerCase() : '';
  const verified = c.email_verified === true || c.email_verified === 'true';
  if (!sub || !email || !verified) throw new JwtError('email_not_verified');
  return {
    provider: 'google',
    subject: sub,
    email,
    name: typeof c.name === 'string' ? c.name.slice(0, 120) : null,
  };
}

/**
 * Checks an identity token from Sign in with Apple: Apple's signature, issuer, audience (the
 * app's bundle id). Apple puts the e-mail address (or a private relay address for "Hide my
 * email") in it at least at the first sign-in; later it may be missing, then the Apple user id
 * finds the account.
 */
export async function verifyAppleIdToken(
  token: string,
  opts: { audiences: string[]; keys: KeyLookup; now?: Date },
): Promise<Identity> {
  const c = await verifyJwt(token, {
    keys: opts.keys,
    issuers: [APPLE_ISSUER],
    audiences: opts.audiences,
    now: opts.now,
  });
  const sub = typeof c.sub === 'string' ? c.sub : '';
  if (!sub) throw new JwtError('no_subject');
  const email = typeof c.email === 'string' ? c.email.trim().toLowerCase() : '';
  // Apple sends the flag as a string or a boolean; relay addresses are always verified
  const verified =
    c.email_verified === true ||
    c.email_verified === 'true' ||
    c.is_private_email === true ||
    c.is_private_email === 'true';
  return { provider: 'apple', subject: sub, email: email && verified ? email : null, name: null };
}

export type DeviceInput = Omit<PairInput, 'code' | 'now'>;

export type SignInResult =
  | { ok: true; token: string; device: Device; account: Account; created: boolean }
  | { ok: false; problem: 'device_limit'; seats: number }
  | { ok: false; problem: 'no_email' };

async function createAppAccount(
  tx: Db,
  input: {
    email: string;
    name: string | null;
    via: 'google' | 'apple' | 'email' | 'review';
    verified: boolean;
    now: Date;
  },
): Promise<{ account: Account; created: boolean }> {
  const [a] = await tx<(AccountRow & { created: boolean })[]>`
    INSERT INTO accounts (public_id, email, name, locale, signup_via, email_verified_at, last_login_at)
    VALUES (${newPublicId('acc')}, ${input.email}, ${input.name}, 'en', ${input.via},
            ${input.verified ? input.now : null}, ${input.now})
    ON CONFLICT (email) DO UPDATE SET last_login_at = EXCLUDED.last_login_at,
      email_verified_at = coalesce(accounts.email_verified_at, EXCLUDED.email_verified_at)
    RETURNING ${tx.unsafe(ACCOUNT_COLUMNS)}, (xmax = 0) AS created`;
  return { account: toAccount(a!), created: Boolean(a!.created) };
}

async function finishSignIn(
  tx: Db,
  account: Account,
  created: boolean,
  device: DeviceInput,
  opts: { baseUrl: string; now: Date },
): Promise<SignInResult> {
  const r = await registerDevice(tx, account, { ...device, now: opts.now });
  if (!r.ok) return r;
  await tx`UPDATE accounts SET last_login_at = ${opts.now} WHERE id = ${account.id}`;
  if (created) await sendVerificationLink(tx, account, { baseUrl: opts.baseUrl, now: opts.now });
  return { ok: true, token: r.token, device: r.device, account, created };
}

/**
 * Signs in with a checked Google (or Apple) identity: the account it was used with before, else
 * the account with its e-mail address, else a new account with that address.
 */
export async function signInWithIdentity(
  sql: Sql,
  identity: Identity,
  device: DeviceInput,
  opts: {
    baseUrl: string;
    now?: Date;
    /** Sign in with Apple: the refresh token from the app's code, encrypted (revoked at deletion) */
    refreshTokenEnc?: string | null;
  },
): Promise<SignInResult> {
  const now = opts.now ?? new Date();
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`identity:${identity.provider}:${identity.subject}`}))`;
    const [known] = await tx<{ account_id: number }[]>`
      SELECT account_id FROM account_identities
       WHERE provider = ${identity.provider} AND subject = ${identity.subject}`;
    let account: Account | null = null;
    let created = false;
    if (known) {
      const [a] = await tx<AccountRow[]>`
        SELECT ${tx.unsafe(ACCOUNT_COLUMNS)} FROM accounts WHERE id = ${known.account_id}`;
      account = a ? toAccount(a) : null;
    }
    if (!account) {
      if (!identity.email) return { ok: false, problem: 'no_email' };
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`login:${identity.email}`}))`;
      ({ account, created } = await createAppAccount(tx, {
        email: identity.email,
        name: identity.name,
        via: identity.provider,
        verified: false,
        now,
      }));
    }
    await tx`
      INSERT INTO account_identities (provider, subject, account_id, email, created_at, last_used_at,
                                      refresh_token_enc)
      VALUES (${identity.provider}, ${identity.subject}, ${account.id}, ${identity.email}, ${now}, ${now},
              ${opts.refreshTokenEnc ?? null})
      ON CONFLICT (provider, subject) DO UPDATE
        SET account_id = EXCLUDED.account_id, last_used_at = EXCLUDED.last_used_at,
            email = coalesce(EXCLUDED.email, account_identities.email),
            refresh_token_enc = coalesce(EXCLUDED.refresh_token_enc,
                                         account_identities.refresh_token_enc)`;
    return finishSignIn(tx, account, created, device, { baseUrl: opts.baseUrl, now });
  });
}

const codeHash = (email: string, code: string) =>
  createHash('sha256').update(`${email}:${code}`).digest('hex');

export type Review = { email: string; code: string } | null;

export type CodeRequest =
  | { ok: true; resendAfter: number }
  | { ok: false; problem: 'invalid_email' }
  | { ok: false; problem: 'rate_limited'; retryAfter: number };

/** "Use another email": e-mails a 6-digit code (once a minute, 5 an hour per address). */
export async function requestAppCode(
  sql: Sql,
  input: { email: string; now?: Date; review?: Review; testHooks?: boolean },
): Promise<CodeRequest> {
  const parsed = LoginRequest.safeParse({ email: input.email });
  if (!parsed.success) return { ok: false, problem: 'invalid_email' };
  const email = parsed.data.email;
  const now = input.now ?? new Date();
  // the review account signs in with its fixed code; nothing is sent
  if (input.review && email === input.review.email) return { ok: true, resendAfter: 0 };
  return sql.begin(async (tx): Promise<CodeRequest> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`code:${email}`}))`;
    const recent = await tx<{ created_at: Date }[]>`
      SELECT created_at FROM app_login_codes
       WHERE email = ${email} AND created_at > ${now}::timestamptz - interval '1 hour'
       ORDER BY created_at DESC`;
    const last = recent[0];
    const since = last ? Math.floor((now.getTime() - last.created_at.getTime()) / 1000) : null;
    if (since !== null && since < CODE_RESEND_SECONDS) {
      return { ok: true, resendAfter: CODE_RESEND_SECONDS - since };
    }
    if (recent.length >= CODES_PER_HOUR) {
      const oldest = recent[recent.length - 1]!.created_at.getTime();
      return {
        ok: false,
        problem: 'rate_limited',
        retryAfter: Math.max(60, Math.ceil((oldest + 3600_000 - now.getTime()) / 1000)),
      };
    }
    const test = Boolean(input.testHooks) && email.endsWith(TEST_EMAIL_DOMAIN);
    const code = test ? TEST_CODE : String(randomInt(0, 1_000_000)).padStart(6, '0');
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO app_login_codes (email, code_hash, created_at, expires_at)
      VALUES (${email}, ${codeHash(email, code)}, ${now},
              ${now}::timestamptz + make_interval(mins => ${CODE_MINUTES}))
      RETURNING id`;
    if (!test) {
      const [a] = await tx<
        { locale: 'de' | 'en' }[]
      >`SELECT locale FROM accounts WHERE email = ${email}`;
      await enqueueMail(tx, {
        template: 'app_login_code',
        to: email,
        locale: a?.locale ?? 'en',
        payload: { code, minutes: CODE_MINUTES },
        dedupeKey: `app_login_code:${row!.id}`,
      });
    }
    return { ok: true, resendAfter: CODE_RESEND_SECONDS };
  });
}

export type CodeSignIn =
  | SignInResult
  | { ok: false; problem: 'invalid_email' | 'code_expired' }
  | { ok: false; problem: 'wrong_code'; triesLeft: number }
  | { ok: false; problem: 'rate_limited' };

/** Checks the e-mailed code and signs in: the account with this address, or a new one. */
export async function verifyAppCode(
  sql: Sql,
  input: {
    email: string;
    code: string;
    device: DeviceInput;
    baseUrl: string;
    now?: Date;
    review?: Review;
    testHooks?: boolean;
  },
): Promise<CodeSignIn> {
  const parsed = LoginRequest.safeParse({ email: input.email });
  if (!parsed.success) return { ok: false, problem: 'invalid_email' };
  const email = parsed.data.email;
  const code = String(input.code ?? '').trim();
  const now = input.now ?? new Date();
  const opts = { baseUrl: input.baseUrl, now };

  if (input.review && email === input.review.email) {
    if (!input.review.code || code !== input.review.code) {
      return { ok: false, problem: 'wrong_code', triesLeft: CODE_TRIES };
    }
    return sql.begin(async (tx) => {
      const { account, created } = await ensureReviewAccount(tx, email, now);
      return finishSignIn(tx, account, created, input.device, opts);
    });
  }

  return sql.begin(async (tx): Promise<CodeSignIn> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`code:${email}`}))`;
    const [c] = await tx<
      { id: number; code_hash: string; tries: number; expires_at: Date; used_at: Date | null }[]
    >`
      SELECT id, code_hash, tries, expires_at, used_at FROM app_login_codes
       WHERE email = ${email} ORDER BY created_at DESC LIMIT 1`;
    if (!c || c.used_at || c.expires_at <= now) return { ok: false, problem: 'code_expired' };
    if (c.tries >= CODE_TRIES) return { ok: false, problem: 'rate_limited' };
    if (!/^\d{6}$/.test(code) || codeHash(email, code) !== c.code_hash) {
      await tx`UPDATE app_login_codes SET tries = tries + 1 WHERE id = ${c.id}`;
      return { ok: false, problem: 'wrong_code', triesLeft: Math.max(0, CODE_TRIES - c.tries - 1) };
    }
    await tx`UPDATE app_login_codes SET used_at = ${now} WHERE id = ${c.id}`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`login:${email}`}))`;
    const { account, created } = await createAppAccount(tx, {
      email,
      name: null,
      via: 'email',
      verified: true,
      now,
    });
    return finishSignIn(tx, account, created, input.device, opts);
  });
}

/** Devices the review account may use at the same time. */
export const REVIEW_DEVICES = 10;

/**
 * The account Google's and Apple's reviewers sign in with: a free Creator subscription without
 * end and room for 10 devices.
 */
export async function ensureReviewAccount(
  tx: Db,
  email: string,
  now = new Date(),
): Promise<{ account: Account; created: boolean }> {
  const r = await createAppAccount(tx, { email, name: null, via: 'review', verified: true, now });
  await tx`
    INSERT INTO subscriptions (account_id, source, plan, extra_devices, status, note, granted_by)
    VALUES (${r.account.id}, 'complimentary', 'creator', ${REVIEW_DEVICES - 1}, 'complimentary',
            'App review', 'review')
    ON CONFLICT (account_id) DO UPDATE SET
      source = 'complimentary', plan = 'creator', extra_devices = ${REVIEW_DEVICES - 1},
      status = 'complimentary', stripe_subscription_id = NULL, ends_at = NULL, ended_at = NULL,
      cancel_at_period_end = false, note = 'App review'
     WHERE subscriptions.source <> 'stripe'`;
  return r;
}

/**
 * Every Monday the review account starts clean: collection, missing cards, shares and devices
 * go. Returns whether it was reset.
 */
export async function resetReviewAccount(
  db: Db,
  email: string,
  now = new Date(),
): Promise<boolean> {
  const [a] = await db<{ id: number }[]>`SELECT id FROM accounts WHERE email = ${email}`;
  if (!a) return false;
  // Monday 00:00 in Vienna of this week
  const [w] = await db<{ monday: Date; last: Date | null }[]>`
    SELECT (date_trunc('week', ${now}::timestamptz AT TIME ZONE 'Europe/Vienna') AT TIME ZONE 'Europe/Vienna') AS monday,
           (SELECT (value ->> 'at')::timestamptz FROM settings WHERE key = 'review_reset_at') AS last`;
  if (w!.last && w!.last >= w!.monday) return false;
  await db`DELETE FROM collection_items WHERE account_id = ${a.id}`;
  await db`DELETE FROM collection_binders WHERE account_id = ${a.id}`;
  await db`DELETE FROM collection_shares WHERE account_id = ${a.id}`;
  await db`DELETE FROM wanted_cards WHERE account_id = ${a.id}`;
  await db`
    UPDATE devices SET ended_at = ${now}, end_reason = 'removed'
     WHERE account_id = ${a.id} AND ended_at IS NULL`;
  await db`
    INSERT INTO settings (key, value) VALUES ('review_reset_at', ${db.json({ at: now.toISOString() })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  return true;
}

/**
 * Accounts made in the app with Google or Apple whose address was never confirmed and that never
 * had a subscription: deleted after 30 days.
 */
export async function deleteUnconfirmedAppAccounts(db: Db, now = new Date()): Promise<number> {
  // (Sign in with Apple tokens are revoked at Apple first, as at any deletion)
  const [r] = await db<{ n: number }[]>`
    WITH gone AS (
      DELETE FROM accounts a
       WHERE a.signup_via IN ('google', 'apple') AND a.email_verified_at IS NULL
         AND a.created_at < ${now}::timestamptz - interval '30 days'
         AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.account_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM store_purchases p WHERE p.account_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.account_id = a.id)
       RETURNING a.id),
    queued AS (
      INSERT INTO apple_token_revocations (token_enc, test)
      SELECT i.refresh_token_enc, i.subject LIKE 'test:%'
        FROM account_identities i JOIN gone g ON g.id = i.account_id
       WHERE i.provider = 'apple' AND i.refresh_token_enc IS NOT NULL
      RETURNING 1)
    SELECT (SELECT count(*) FROM gone)::int AS n, (SELECT count(*) FROM queued) AS q`;
  return r?.n ?? 0;
}

/** Days a Sign in with Apple token of a deleted account is tried to be revoked. */
export const REVOKE_DAYS = 30;

/**
 * Deleted accounts: revokes their Sign in with Apple tokens at Apple (Apple requires it), so
 * Apple forgets that the person signed in to the app. Retried with growing pauses, up to
 * REVOKE_DAYS. Worker; also right after the deletion.
 */
export async function revokeAppleTokens(
  sql: Sql,
  key: AppleSignInKey | null,
  masterKey: Buffer | null,
  opts: { now?: Date; fetch?: typeof fetch } = {},
): Promise<{ revoked: number; failed: number; dropped: number }> {
  const now = opts.now ?? new Date();
  const due = await sql<
    { id: number; token_enc: string; test: boolean; tries: number; created_at: Date }[]
  >`
    SELECT id, token_enc, test, tries, created_at FROM apple_token_revocations
     WHERE next_try_at <= greatest(${now}::timestamptz, now()) ORDER BY next_try_at LIMIT 50`;
  let revoked = 0;
  let failed = 0;
  let dropped = 0;
  for (const d of due) {
    try {
      // tokens made with the staging test hooks don't exist at Apple
      if (!d.test) {
        if (!key || !masterKey) throw new Error('Sign in with Apple is not set up');
        await revokeAppleToken(key, decryptSecret(d.token_enc, masterKey), opts.fetch);
      }
      await sql`DELETE FROM apple_token_revocations WHERE id = ${d.id}`;
      revoked++;
    } catch (e) {
      if (d.created_at.getTime() < now.getTime() - REVOKE_DAYS * 86400_000) {
        console.error(`[apple] giving up revoking a token: ${(e as Error).message}`);
        await sql`DELETE FROM apple_token_revocations WHERE id = ${d.id}`;
        dropped++;
        continue;
      }
      const hours = Math.min(24, 2 ** d.tries);
      await sql`
        UPDATE apple_token_revocations
           SET tries = tries + 1, last_error = ${(e as Error).message.slice(0, 300)},
               next_try_at = ${now}::timestamptz + make_interval(hours => ${hours})
         WHERE id = ${d.id}`;
      failed++;
    }
  }
  return { revoked, failed, dropped };
}
