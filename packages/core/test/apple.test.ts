import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  alpha2,
  APPLE_ROOT_CA_G3_SHA256,
  appleClientSecret,
  appleSubscriptionOf,
  appStoreClient,
  exchangeAppleCode,
  parseAppleNotification,
  parseAppleRenewal,
  parseAppleTransaction,
  revokeAppleToken,
  verifyAppleJws,
  type AppleSignInKey,
} from '../src/apple.ts';
import { verifyAppleIdToken } from '../src/app-signin.ts';
import { decodeJwt, localKeys, signRs256, verifySignature } from '../src/jwt.ts';
import { PurchaseInvalid, StoreUnavailable } from '../src/store.ts';
import { appleTx, BUNDLE, FakeAppleApi, signApple, TEST_ROOT, testP8 } from './apple-fixture.ts';

const DAY = 86400_000;
const roots = [TEST_ROOT];

test('a JWS from the App Store checks out only with its whole chain and signature', () => {
  const tx = appleTx({
    original: '2000000111',
    product: 'oc.collector.monthly',
    expires: new Date(),
  });
  const jws = signApple(tx);
  assert.equal(verifyAppleJws(jws, { roots }).originalTransactionId, '2000000111');
  // our root is not Apple's
  assert.throws(() => verifyAppleJws(jws), { code: 'untrusted_root' });
  assert.match(APPLE_ROOT_CA_G3_SHA256, /^[0-9A-F]{64}$/);
  // a changed payload
  const [h, , s] = jws.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...tx, productId: 'x' })).toString('base64url')}.${s}`;
  assert.throws(() => verifyAppleJws(forged, { roots }), { code: 'signature' });
  // a leaf without Apple's marker, a chain without its root
  assert.throws(() => verifyAppleJws(signApple(tx, { chain: 'no-marker' }), { roots }), {
    code: 'certificate_chain',
  });
  assert.throws(() => verifyAppleJws(signApple(tx, { chain: 'two' }), { roots }), {
    code: 'certificate_chain',
  });
  // certificates not valid when it was signed
  assert.throws(
    () => verifyAppleJws(signApple({ ...tx, signedDate: Date.parse('2001-01-01') }), { roots }),
    { code: 'certificate_expired' },
  );
  // not a JWS, another algorithm
  assert.throws(() => verifyAppleJws('nope', { roots }), { code: 'malformed' });
  const rs = signRs256(
    { a: 1 },
    generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  );
  assert.throws(() => verifyAppleJws(rs, { roots }), { code: 'algorithm' });
});

test('transactions, renewal info and the status map to the shop’s states', () => {
  const end = new Date(Date.now() + 10 * DAY);
  const ref = '7f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b';
  const tx = parseAppleTransaction(
    appleTx({ original: '2000000222', product: 'p', expires: end, token: ref.toUpperCase() }),
  );
  assert.equal(tx.appAccountToken, ref);
  assert.equal(tx.country, 'AT');
  assert.equal(tx.environment, 'Production');
  assert.throws(() => parseAppleTransaction({ productId: 'x' }), PurchaseInvalid);
  const renew = parseAppleRenewal({ autoRenewStatus: 1 });
  const off = parseAppleRenewal({ autoRenewStatus: 0 });
  const grace = parseAppleRenewal({
    autoRenewStatus: 1,
    gracePeriodExpiresDate: end.getTime() + 3 * DAY,
  });
  assert.equal(appleSubscriptionOf(1, tx, renew).state, 'active');
  assert.equal(appleSubscriptionOf(1, tx, off).state, 'canceled');
  assert.equal(appleSubscriptionOf(1, tx, off).autoRenew, false);
  const g = appleSubscriptionOf(4, tx, grace);
  assert.equal(g.state, 'grace');
  assert.equal(g.expiresAt!.getTime(), end.getTime() + 3 * DAY);
  assert.equal(appleSubscriptionOf(3, tx, renew).state, 'on_hold');
  assert.equal(appleSubscriptionOf(2, tx, off).state, 'expired');
  assert.equal(appleSubscriptionOf(5, tx, renew).state, 'revoked');
  const refunded = parseAppleTransaction(
    appleTx({ original: '2000000222', product: 'p', expires: end, revoked: new Date() }),
  );
  assert.equal(appleSubscriptionOf(1, refunded, renew).state, 'revoked');
  assert.equal(appleSubscriptionOf(1, refunded, renew).autoRenew, false);
  const sandbox = parseAppleTransaction(
    appleTx({ original: '2000000222', product: 'p', expires: end, environment: 'Sandbox' }),
  );
  assert.equal(appleSubscriptionOf(1, sandbox, renew).test, true);
  assert.equal(alpha2('DEU'), 'DE');
  assert.equal(alpha2('usa'), 'US');
  assert.equal(alpha2('XKS'), 'XK');
  assert.equal(alpha2('ZZZ'), null);
  assert.equal(alpha2(null), null);
});

test('the App Store Server API client signs in, falls back to the sandbox and checks the app', async () => {
  const p8 = testP8();
  const api = new FakeAppleApi();
  const end = new Date(Date.now() + 20 * DAY);
  api.subs.set('2000000333', {
    status: 1,
    tx: appleTx({ original: '2000000333', product: 'oc.creator.yearly', expires: end }),
  });
  api.subs.set('2000000444', {
    status: 1,
    environment: 'Sandbox',
    autoRenew: false,
    tx: appleTx({
      original: '2000000444',
      product: 'oc.collector.monthly',
      expires: end,
      environment: 'Sandbox',
    }),
  });
  const client = appStoreClient({
    bundleId: BUNDLE,
    issuerId: '57246542-96fe-1a63-e053-0824d011072a',
    keyId: 'ABC123DEFG',
    privateKey: p8.pem,
    fetch: api.fetch,
    roots,
  });
  const s = await client.getSubscription('2000000333', { sandbox: false });
  assert.equal(s.state, 'active');
  assert.equal(s.productId, 'oc.creator.yearly');
  assert.equal(s.expiresAt!.getTime(), end.getTime());
  assert.equal(s.test, false);
  // the bearer token: ES256 with the key, for the app
  const jwt = decodeJwt(api.calls[0]!.auth.replace('Bearer ', ''));
  assert.equal(jwt.header.alg, 'ES256');
  assert.equal(jwt.header.kid, 'ABC123DEFG');
  assert.equal(jwt.payload.aud, 'appstoreconnect-v1');
  assert.equal(jwt.payload.bid, BUNDLE);
  assert.equal(jwt.payload.iss, '57246542-96fe-1a63-e053-0824d011072a');
  assert.ok(verifySignature(jwt, p8.publicKey));
  // production first, then the sandbox (TestFlight and App Review buy there)
  api.calls = [];
  const sb = await client.getSubscription('2000000444', { sandbox: false });
  assert.equal(sb.state, 'canceled');
  assert.equal(sb.test, true);
  assert.deepEqual(
    api.calls.map((c) => new URL(c.url).host),
    ['api.storekit.itunes.apple.com', 'api.storekit-sandbox.itunes.apple.com'],
  );
  await assert.rejects(client.getSubscription('2000000999', { sandbox: false }), PurchaseInvalid);
  await assert.rejects(client.getSubscription('../x', { sandbox: false }), PurchaseInvalid);
  api.bundleId = 'com.someone.else';
  await assert.rejects(client.getSubscription('2000000333', { sandbox: false }), PurchaseInvalid);
  api.bundleId = BUNDLE;
  api.down = true;
  await assert.rejects(client.getSubscription('2000000333', { sandbox: false }), StoreUnavailable);
  api.down = false;
  api.unauthorized = true;
  await assert.rejects(client.getSubscription('2000000333', { sandbox: false }), StoreUnavailable);
});

test('notifications: the signed payload and the transaction inside are checked', () => {
  const verify = (j: string) => verifyAppleJws(j, { roots });
  const tx = appleTx({ original: '2000000555', product: 'p', expires: new Date() });
  const body = {
    signedPayload: signApple({
      notificationType: 'DID_RENEW',
      notificationUUID: '002e14d5-51f5-4503-b5a8-c3a1af68eb20',
      data: {
        bundleId: BUNDLE,
        environment: 'Sandbox',
        signedTransactionInfo: signApple(tx),
        signedRenewalInfo: signApple({ autoRenewStatus: 1 }),
        status: 1,
      },
      version: '2.0',
      signedDate: Date.now(),
    }),
  };
  const n = parseAppleNotification(body, verify)!;
  assert.equal(n.type, 'DID_RENEW');
  assert.equal(n.environment, 'Sandbox');
  assert.equal(n.transaction!.originalTransactionId, '2000000555');
  const test = parseAppleNotification(
    { signedPayload: signApple({ notificationType: 'TEST', data: { bundleId: BUNDLE } }) },
    verify,
  )!;
  assert.equal(test.type, 'TEST');
  assert.equal(test.transaction, null);
  assert.equal(parseAppleNotification({}, verify), null);
  assert.throws(() =>
    parseAppleNotification({ signedPayload: body.signedPayload.slice(0, -4) + 'AAAA' }, verify),
  );
});

test('Sign in with Apple: identity tokens, the code exchange and revoking', async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keys = localKeys({ k1: rsa.publicKey });
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://appleid.apple.com',
    aud: BUNDLE,
    sub: '001234.abcdef0123456789.0042',
    iat: now,
    exp: now + 600,
  };
  const id = await verifyAppleIdToken(
    signRs256(
      { ...claims, email: 'Kim@privaterelay.appleid.com', is_private_email: 'true' },
      pem,
      'k1',
    ),
    { audiences: [BUNDLE], keys },
  );
  assert.deepEqual(id, {
    provider: 'apple',
    subject: '001234.abcdef0123456789.0042',
    email: 'kim@privaterelay.appleid.com',
    name: null,
  });
  // later sign-ins may come without the address
  assert.equal(
    (await verifyAppleIdToken(signRs256(claims, pem, 'k1'), { audiences: [BUNDLE], keys })).email,
    null,
  );
  await assert.rejects(
    verifyAppleIdToken(signRs256({ ...claims, aud: 'com.other.app' }, pem, 'k1'), {
      audiences: [BUNDLE],
      keys,
    }),
    { code: 'audience' },
  );
  await assert.rejects(
    verifyAppleIdToken(signRs256({ ...claims, iss: 'https://accounts.google.com' }, pem, 'k1'), {
      audiences: [BUNDLE],
      keys,
    }),
    { code: 'issuer' },
  );

  const p8 = testP8();
  const key: AppleSignInKey = {
    teamId: 'TEAM123456',
    keyId: 'SIWA123456',
    privateKey: p8.pem,
    clientId: BUNDLE,
  };
  const secret = decodeJwt(appleClientSecret(key));
  assert.equal(secret.payload.iss, 'TEAM123456');
  assert.equal(secret.payload.sub, BUNDLE);
  assert.equal(secret.payload.aud, 'https://appleid.apple.com');
  assert.ok(verifySignature(secret, p8.publicKey));

  const forms: URLSearchParams[] = [];
  let answer: Response = Response.json({});
  const fake: typeof fetch = async (_u, init) => {
    forms.push(new URLSearchParams(String(init?.body)));
    return answer.clone();
  };
  const idToken = signRs256({ ...claims }, pem, 'k1');
  answer = Response.json({ access_token: 'a', refresh_token: 'r.1', id_token: idToken });
  assert.equal(await exchangeAppleCode(key, 'c.1', claims.sub, fake), 'r.1');
  assert.equal(forms[0]!.get('grant_type'), 'authorization_code');
  assert.equal(forms[0]!.get('client_id'), BUNDLE);
  assert.equal(forms[0]!.get('code'), 'c.1');
  // a code of another Apple ID is not kept
  assert.equal(await exchangeAppleCode(key, 'c.2', 'someone.else', fake), null);
  answer = Response.json({ error: 'invalid_grant' }, { status: 400 });
  await assert.rejects(exchangeAppleCode(key, 'c.3', claims.sub, fake), /invalid_grant/);
  answer = Response.json({ error: 'invalid_client' }, { status: 400 });
  await assert.rejects(exchangeAppleCode(key, 'c.3', claims.sub, fake), StoreUnavailable);

  answer = new Response('', { status: 200 });
  await revokeAppleToken(key, 'r.1', fake);
  assert.equal(forms.at(-1)!.get('token'), 'r.1');
  assert.equal(forms.at(-1)!.get('token_type_hint'), 'refresh_token');
  // already invalid: nothing left to revoke
  answer = Response.json({ error: 'invalid_grant' }, { status: 400 });
  await revokeAppleToken(key, 'r.1', fake);
  answer = new Response('', { status: 503 });
  await assert.rejects(revokeAppleToken(key, 'r.1', fake), StoreUnavailable);
});
