import { test } from 'node:test';
import assert from 'node:assert/strict';
import { licensePricing, netLicensePrice } from '../src/licenses.ts';
import { fakeProvider, paymentsFromEnv, stripeProvider } from '../src/payments.ts';
import { licenseCountryAllowed, parseTaxId, viesChecker } from '../src/tax-id.ts';

test('tax ids are read per country and written as Stripe expects them', () => {
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
    ['CH', 'CHE-123.456.789 MWST', { type: 'ch_vat', value: 'CHE-123.456.789 MWST' }],
    ['CH', 'che123456789', { type: 'ch_uid', value: 'CHE-123.456.789' }],
    ['LI', 'CHE-123.456.789', { type: 'li_uid', value: 'CHE123456789' }],
    ['LI', '12345', { type: 'li_vat', value: '12345' }],
    ['NO', '123 456 789', { type: 'no_vat', value: '123456789MVA' }],
    ['IS', '123456', { type: 'is_vat', value: '123456' }],
    ['GB', 'GB 123 4567 89', { type: 'gb_vat', value: 'GB123456789' }],
    ['US', '12-3456789', { type: 'us_ein', value: '12-3456789' }],
    ['US', '1234', null],
    ['CA', '123456789RT0001', { type: 'ca_bn', value: '123456789' }],
    ['AU', '51 824 753 556', { type: 'au_abn', value: '51824753556' }],
    ['JP', '1234567890123', null],
  ];
  for (const [country, raw, want] of cases) {
    assert.deepEqual(parseTaxId(country, raw), want, `${country} ${raw}`);
  }
});

test('who may buy: consumers in the EU, businesses also in eight countries outside', () => {
  assert.equal(licenseCountryAllowed('FR', false), true);
  assert.equal(licenseCountryAllowed('CH', false), false);
  assert.equal(licenseCountryAllowed('CH', true), true);
  assert.equal(licenseCountryAllowed('AU', true), true);
  assert.equal(licenseCountryAllowed('JP', true), false);
});

test('price by buyer: gross with VAT, net for businesses abroad', () => {
  assert.equal(netLicensePrice(13900), 11583);
  const p = (business: boolean, country: string, taxId: boolean) =>
    licensePricing({
      grossCents: 13900,
      business,
      country,
      taxId: taxId ? { type: 'x', value: 'x' } : null,
    });
  assert.equal(p(false, 'IT', false).rateBp, 2200, 'the buyer’s country’s rate (OSS)');
  assert.equal(p(true, 'AT', true).unitCents, 13900, 'Austrian businesses pay Austrian VAT');
  assert.equal(p(true, 'IT', true).regime, 'reverse_charge');
  assert.equal(p(true, 'IT', false).regime, 'oss', 'without a VAT id as a consumer');
  assert.equal(p(true, 'CA', true).regime, 'export');
  assert.equal(p(true, 'CA', true).taxCountry, null);
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
  const live = { PUBLIC_BASE_URL: 'https://pokemonkarten.at' };
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
