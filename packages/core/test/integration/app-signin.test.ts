import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { localKeys, signRs256 } from '../../src/jwt.ts';
import {
  deleteUnconfirmedAppAccounts,
  requestAppCode,
  resetReviewAccount,
  signInWithIdentity,
  verifyAppCode,
  verifyGoogleIdToken,
} from '../../src/app-signin.ts';
import { appStatus, deviceByToken } from '../../src/devices.ts';
import { accountByEmail, redeemLoginLink } from '../../src/accounts.ts';
import { accountEntitlements } from '../../src/subscriptions.ts';

let sql: Sql;
let drop: () => Promise<void>;
const BASE = 'http://localhost:3000';
const CLIENT = '123-web.apps.googleusercontent.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const keys = localKeys({ k1: publicKey });
const now = () => Math.floor(Date.now() / 1000);
const device = (n: number) => ({
  deviceUuid: `device-${n}-0000-4000-8000-000000000000`,
  name: `Pixel ${n}`,
  appVersion: '2.0.0',
  platform: 'android',
});
const idToken = (over: Record<string, unknown> = {}) =>
  signRs256(
    {
      iss: 'https://accounts.google.com',
      aud: CLIENT,
      sub: '1098765',
      email: 'Anna@Example.com',
      email_verified: true,
      name: 'Anna',
      iat: now(),
      exp: now() + 3600,
      ...over,
    },
    pem,
    'k1',
  );

before(async () => {
  ({ sql, drop } = await freshDatabase());
});
after(async () => drop());

const mails = (template: string, to?: string) => sql<
  { to_address: string; payload: Record<string, unknown> }[]
>`
  SELECT to_address, payload FROM outbox WHERE template = ${template}
   ${to ? sql`AND to_address = ${to}` : sql``} ORDER BY id`;

test('Google ID tokens: signature, audience, issuer, expiry, confirmed address', async () => {
  const id = await verifyGoogleIdToken(idToken(), { audiences: [CLIENT], keys });
  assert.deepEqual(id, {
    provider: 'google',
    subject: '1098765',
    email: 'anna@example.com',
    name: 'Anna',
  });
  const bad = async (token: string, code: string) =>
    assert.rejects(verifyGoogleIdToken(token, { audiences: [CLIENT], keys }), { code });
  await bad(idToken({ aud: 'other' }), 'audience');
  await bad(idToken({ iss: 'https://evil.example' }), 'issuer');
  await bad(idToken({ exp: now() - 600 }), 'expired');
  await bad(idToken({ email_verified: false }), 'email_not_verified');
  await bad(`${idToken().slice(0, -4)}AAAA`, 'signature');
  await bad('not.a.token', 'malformed');
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await bad(
    signRs256(
      { iss: 'accounts.google.com', aud: CLIENT, exp: now() + 60 },
      other.export({ type: 'pkcs8', format: 'pem' }).toString(),
      'k1',
    ),
    'signature',
  );
});

test('Continue with Google: new account, same account again, existing portal account', async () => {
  const identity = await verifyGoogleIdToken(idToken(), { audiences: [CLIENT], keys });
  const r = await signInWithIdentity(sql, identity, device(1), { baseUrl: BASE });
  assert.ok(r.ok && r.created);
  assert.equal(r.account.email, 'anna@example.com');
  assert.equal(r.account.signupVia, 'google');
  assert.equal(r.account.emailVerified, false);
  assert.match(r.account.storeRef, /^[0-9a-f-]{36}$/);
  const [verify] = await mails('account_verify', 'anna@example.com');
  assert.equal(verify!.payload.verified, false);
  assert.match(String(verify!.payload.url), /\/login\/link\?t=/);
  // the token works and the status says "none": no subscription yet
  const t = await deviceByToken(sql, r.token);
  assert.ok(t.ok);
  const st = await appStatus(sql, t.account, t.device, { baseUrl: BASE });
  assert.equal(st.status, 'none');
  assert.equal(st.subscription.state, 'none');
  assert.equal(st.subscription.source, null);
  assert.equal(st.account.store_ref, r.account.storeRef);
  assert.equal(st.account.email_verified, false);
  // again (another phone): same account, no second mail
  const again = await signInWithIdentity(sql, identity, device(2), { baseUrl: BASE });
  assert.ok(again.ok && !again.created && again.account.id === r.account.id);
  assert.equal((await mails('account_verify', 'anna@example.com')).length, 1);
  // the link confirms the address
  const link = await redeemLoginLink(
    sql,
    new URL(String(verify!.payload.url)).searchParams.get('t')!,
  );
  assert.ok(link.ok && link.account.emailVerified);
  // a portal account signs in with Google by its address
  await sql`INSERT INTO accounts (public_id, email, email_verified_at) VALUES ('acc_portal0001', 'ben@example.com', now())`;
  const ben = await signInWithIdentity(
    sql,
    { provider: 'google', subject: 'g-ben', email: 'ben@example.com', name: 'Ben' },
    device(3),
    { baseUrl: BASE },
  );
  assert.ok(ben.ok && !ben.created && ben.account.publicId === 'acc_portal0001');
});

test('without a subscription a few devices may sign in; the same phone keeps one slot', async () => {
  const identity = {
    provider: 'google' as const,
    subject: 'g-many',
    email: 'many@example.com',
    name: null,
  };
  for (let i = 10; i < 15; i++) {
    assert.ok((await signInWithIdentity(sql, identity, device(i), { baseUrl: BASE })).ok);
  }
  assert.ok(
    (await signInWithIdentity(sql, identity, device(10), { baseUrl: BASE })).ok,
    'same phone',
  );
  assert.deepEqual(await signInWithIdentity(sql, identity, device(15), { baseUrl: BASE }), {
    ok: false,
    problem: 'device_limit',
    seats: 5,
  });
});

test('e-mail codes: once a minute, five an hour, five tries, ten minutes, once', async () => {
  const t0 = new Date('2026-11-16T10:00:00Z');
  assert.deepEqual(await requestAppCode(sql, { email: 'nope' }), {
    ok: false,
    problem: 'invalid_email',
  });
  assert.deepEqual(await requestAppCode(sql, { email: 'Cara@Example.com', now: t0 }), {
    ok: true,
    resendAfter: 60,
  });
  assert.deepEqual(
    await requestAppCode(sql, { email: 'cara@example.com', now: new Date(t0.getTime() + 20_000) }),
    { ok: true, resendAfter: 40 },
  );
  const sent = await mails('app_login_code', 'cara@example.com');
  assert.equal(sent.length, 1);
  const code = String(sent[0]!.payload.code);
  assert.match(code, /^\d{6}$/);
  const wrong = code === '111111' ? '222222' : '111111';
  const verify = (c: string, at = t0) =>
    verifyAppCode(sql, {
      email: 'cara@example.com',
      code: c,
      device: device(20),
      baseUrl: BASE,
      now: new Date(at.getTime() + 30_000),
    });
  for (let left = 4; left >= 0; left--) {
    assert.deepEqual(await verify(wrong), { ok: false, problem: 'wrong_code', triesLeft: left });
  }
  assert.deepEqual(await verify(code), { ok: false, problem: 'rate_limited' }, 'five wrong tries');
  // a new code a minute later
  const t1 = new Date(t0.getTime() + 61_000);
  assert.deepEqual(await requestAppCode(sql, { email: 'cara@example.com', now: t1 }), {
    ok: true,
    resendAfter: 60,
  });
  const code2 = String((await mails('app_login_code', 'cara@example.com'))[1]!.payload.code);
  // too late
  assert.deepEqual(await verify(code2, new Date(t1.getTime() + 11 * 60_000)), {
    ok: false,
    problem: 'code_expired',
  });
  // codes 3–5 in the hour, then no more
  for (let i = 2; i <= 4; i++) {
    assert.ok(
      (
        await requestAppCode(sql, {
          email: 'cara@example.com',
          now: new Date(t0.getTime() + i * 61_000),
        })
      ).ok,
    );
  }
  const limited = await requestAppCode(sql, {
    email: 'cara@example.com',
    now: new Date(t0.getTime() + 6 * 61_000),
  });
  assert.ok(!limited.ok && limited.problem === 'rate_limited' && limited.retryAfter > 60);
  // the latest code signs in and registers a confirmed account; then it's used up
  const last = String((await mails('app_login_code', 'cara@example.com')).at(-1)!.payload.code);
  const at = new Date(t0.getTime() + 4 * 61_000);
  const ok = await verify(last, at);
  assert.ok(ok.ok && ok.created && ok.account.emailVerified && ok.account.signupVia === 'email');
  const [welcome] = await mails('account_verify', 'cara@example.com');
  assert.equal(welcome!.payload.verified, true);
  assert.deepEqual(await verify(last, at), { ok: false, problem: 'code_expired' });
});

test('staging test addresses take 000000 without a mail; the review account its fixed code', async () => {
  const email = 'ci-1@test.overpricedcardboard.com';
  assert.ok((await requestAppCode(sql, { email, testHooks: true })).ok);
  assert.equal((await mails('app_login_code', email)).length, 0);
  const t = await verifyAppCode(sql, {
    email,
    code: '000000',
    device: device(30),
    baseUrl: BASE,
    testHooks: true,
  });
  assert.ok(t.ok && t.created);

  const review = { email: 'review@overpricedcardboard.com', code: 'R3VIEW-2026' };
  assert.deepEqual(await requestAppCode(sql, { email: review.email, review }), {
    ok: true,
    resendAfter: 0,
  });
  assert.equal((await mails('app_login_code', review.email)).length, 0);
  assert.deepEqual(
    await verifyAppCode(sql, {
      email: review.email,
      code: 'nope',
      device: device(40),
      baseUrl: BASE,
      review,
    }),
    { ok: false, problem: 'wrong_code', triesLeft: 5 },
  );
  for (let i = 40; i < 50; i++) {
    const r = await verifyAppCode(sql, {
      email: review.email,
      code: review.code,
      device: device(i),
      baseUrl: BASE,
      review,
    });
    assert.ok(r.ok, `device ${i}`);
  }
  const acc = await accountByEmail(sql, review.email);
  const ent = await accountEntitlements(sql, acc!);
  assert.equal(ent.plan, 'creator');
  assert.equal(ent.seats, 10);
  assert.equal(ent.state, 'complimentary');
  assert.equal(
    (
      await verifyAppCode(sql, {
        email: review.email,
        code: review.code,
        device: device(50),
        baseUrl: BASE,
        review,
      })
    ).ok,
    false,
    'the 11th device',
  );
  await sql`INSERT INTO wanted_cards (account_id, card_id) VALUES (${acc!.id}, 'base1-4')`;
  const monday = new Date('2026-11-16T08:00:00Z');
  assert.equal(await resetReviewAccount(sql, review.email, monday), true);
  assert.equal(
    await resetReviewAccount(sql, review.email, new Date('2026-11-18T08:00:00Z')),
    false,
    'once a week',
  );
  const [n] = await sql<{ w: number; d: number }[]>`
    SELECT (SELECT count(*)::int FROM wanted_cards WHERE account_id = ${acc!.id}) AS w,
           (SELECT count(*)::int FROM devices WHERE account_id = ${acc!.id} AND ended_at IS NULL) AS d`;
  assert.deepEqual({ ...n }, { w: 0, d: 0 });
  assert.equal(
    await resetReviewAccount(sql, review.email, new Date('2026-11-23T00:30:00Z')),
    true,
    'next Monday',
  );
});

test('unconfirmed Google accounts without a subscription go after 30 days', async () => {
  await sql`
    INSERT INTO accounts (public_id, email, signup_via, created_at)
    VALUES ('acc_oldgoogle1', 'old@example.com', 'google', now() - interval '31 days'),
           ('acc_newgoogle1', 'new@example.com', 'google', now() - interval '3 days')`;
  assert.equal(await deleteUnconfirmedAppAccounts(sql), 1);
  assert.equal(await accountByEmail(sql, 'old@example.com'), null);
  assert.ok(await accountByEmail(sql, 'new@example.com'));
});
