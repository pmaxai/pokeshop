import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeProvider, paymentsFromEnv, stripeProvider } from '../src/payments.ts';
import { parseTaxId, viesChecker } from '../src/tax-id.ts';

test('EU VAT ids are read per country and written as Stripe expects them', () => {
  const cases: [string, string, unknown][] = [
    ['AT', 'atu 1234 5678', { type: 'eu_vat', value: 'ATU12345678' }],
    ['AT', '12345678', null],
    ['DE', '123456789', { type: 'eu_vat', value: 'DE123456789' }],
    ['DE', 'DE 123.456.789', { type: 'eu_vat', value: 'DE123456789' }],
    ['DE', 'ATU12345678', null],
    ['GR', '123456789', { type: 'eu_vat', value: 'EL123456789' }],
    ['GR', 'EL123456789', { type: 'eu_vat', value: 'EL123456789' }],
    ['FR', 'FR40303265045', { type: 'eu_vat', value: 'FR40303265045' }],
    ['NL', 'NL123456789B01', { type: 'eu_vat', value: 'NL123456789B01' }],
    // Outside the EU there is nothing to read (EU VAT ids only).
    ['CH', 'CHE-123.456.789 MWST', null],
    ['GB', 'GB123456789', null],
    ['US', '12-3456789', null],
  ];
  for (const [country, raw, want] of cases) {
    assert.deepEqual(parseTaxId(country, raw), want, `${country} ${raw}`);
  }
});

/** A stand-in for fetch that answers the VIES request. */
const viesAnswer = (status: number, body: unknown) =>
  (async (url: string | URL | Request) => {
    assert.match(String(url), /\/rest-api\/ms\/DE\/vat\/123456789$/);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

test('VIES: valid, invalid, and every other answer counts as unavailable', async () => {
  const check = (status: number, body: unknown) =>
    viesChecker({ fetch: viesAnswer(status, body) })('DE123456789');
  assert.deepEqual(
    await check(200, { isValid: true, name: 'Arena GmbH', address: '---', userError: 'VALID' }),
    { status: 'valid', name: 'Arena GmbH', address: null },
  );
  assert.deepEqual(await check(200, { isValid: false, userError: 'INVALID' }), {
    status: 'invalid',
  });
  assert.deepEqual(await check(200, { isValid: false, userError: 'MS_UNAVAILABLE' }), {
    status: 'unavailable',
    error: 'MS_UNAVAILABLE',
  });
  assert.equal(
    (await check(500, { actionSucceed: false, errorWrappers: [{ error: 'SERVICE_UNAVAILABLE' }] }))
      .status,
    'unavailable',
  );
  const down = viesChecker({
    fetch: (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as typeof fetch,
  });
  assert.equal((await down('DE123456789')).status, 'unavailable');
});

test('each Stripe account knows whose it is', () => {
  assert.equal(fakeProvider('http://localhost:3000').seller, 'shop');
  assert.equal(fakeProvider('http://localhost:3000', 'gmbh').seller, 'gmbh');
  assert.equal(stripeProvider({ secretKey: 'sk_test_x', seller: 'gmbh' }).seller, 'gmbh');
});

test('the GmbH account comes from its own variables, never from the shop’s', () => {
  const live = { PUBLIC_BASE_URL: 'https://overpricedcardboard.com' };
  assert.equal(paymentsFromEnv({ ...live, STRIPE_SECRET_KEY: 'sk_test_shop' }, 'gmbh'), null);
  assert.equal(
    paymentsFromEnv({ ...live, STRIPE_SECRET_KEY: 'sk_test_shop' }, 'shop')?.seller,
    'shop',
  );
  const g = paymentsFromEnv({ ...live, STRIPE_LICENSE_SECRET_KEY: 'sk_test_gmbh' }, 'gmbh');
  assert.equal(g?.name, 'stripe');
  assert.equal(g?.seller, 'gmbh');
  assert.equal(paymentsFromEnv({ PUBLIC_BASE_URL: 'http://localhost:3000' }, 'gmbh')?.name, 'fake');
});
