import { test } from 'node:test';
import assert from 'node:assert/strict';
import { licensePricing, netLicensePrice, stripeTaxProblem } from '../src/licenses.ts';
import { fakeProvider, paymentsFromEnv, stripeProvider } from '../src/payments.ts';
import { licenseCountryAllowed, parseTaxId, viesChecker } from '../src/tax-id.ts';

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
    // Outside the EU there is nothing to read: licences are EU-only.
    ['CH', 'CHE-123.456.789 MWST', null],
    ['GB', 'GB123456789', null],
    ['US', '12-3456789', null],
  ];
  for (const [country, raw, want] of cases) {
    assert.deepEqual(parseTaxId(country, raw), want, `${country} ${raw}`);
  }
});

test('who may buy: private persons and businesses in the EU only', () => {
  assert.equal(licenseCountryAllowed('FR'), true);
  assert.equal(licenseCountryAllowed('AT'), true);
  for (const c of ['CH', 'LI', 'NO', 'IS', 'GB', 'US', 'CA', 'AU', 'JP']) {
    assert.equal(licenseCountryAllowed(c), false, c);
  }
});

test('price by buyer: gross with VAT, net for EU businesses abroad with a VAT id', () => {
  assert.equal(netLicensePrice(13900), 11583);
  const p = (business: boolean, country: string, taxId: boolean) =>
    licensePricing({
      grossCents: 13900,
      business,
      country,
      taxId: taxId ? { type: 'eu_vat', value: 'x' } : null,
    });
  assert.equal(p(false, 'IT', false).rateBp, 2200, 'the buyer’s country’s rate (OSS)');
  assert.equal(p(true, 'AT', true).unitCents, 13900, 'Austrian businesses pay Austrian VAT');
  assert.equal(p(true, 'IT', true).regime, 'reverse_charge');
  assert.equal(p(true, 'IT', false).regime, 'oss', 'without a VAT id as a consumer');
  assert.equal(p(true, 'IT', true).taxCountry, null);
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

test('an alert when Stripe Tax charged other than the buyer was shown', () => {
  const de = { vat_regime: 'oss', tax_country: 'DE', vat_rate_bp: 1900 };
  const line = (rateBp: number, country: string, reason = 'standard_rated') => ({
    rateBp,
    country,
    reason,
  });
  assert.equal(stripeTaxProblem(de, 4439, line(1900, 'DE')), null);
  assert.match(
    stripeTaxProblem(de, 0, line(0, 'DE', 'not_collecting'))!,
    /keine \(not_collecting\)/,
  );
  assert.match(stripeTaxProblem(de, 4633, line(2000, 'AT'))!, /von AT/);
  assert.match(stripeTaxProblem(de, null, null)!, /Stripe Tax aus/);
  const rc = { vat_regime: 'reverse_charge', tax_country: null, vat_rate_bp: 0 };
  assert.equal(stripeTaxProblem(rc, 0, line(0, 'DE', 'reverse_charge')), null);
  assert.match(stripeTaxProblem(rc, 4401, line(1900, 'DE'))!, /keine Umsatzsteuer/);
});
