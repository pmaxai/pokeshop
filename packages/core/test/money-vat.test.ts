import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEuro, formatRate, percentOf, splitGross } from '../src/money.ts';
import { orderVat, vatFor } from '../src/vat.ts';

test('splitGross: 20 % Austrian VAT on € 129,00', () => {
  assert.deepEqual(splitGross(12900, 2000), { net: 10750, vat: 2150 });
});

test('splitGross: net + VAT always equals gross', () => {
  for (const gross of [1, 99, 100, 101, 999, 12345, 49999, 50001, 1_000_000]) {
    for (const rate of [0, 1700, 1900, 2000, 2100, 2550, 2700]) {
      const { net, vat } = splitGross(gross, rate);
      assert.equal(net + vat, gross, `gross ${gross} rate ${rate}`);
      assert.ok(vat >= 0 && net >= 0);
    }
  }
});

test('splitGross rejects fractional cents', () => {
  assert.throws(() => splitGross(10.5, 2000), TypeError);
});

test('percentOf rounds to the cent', () => {
  assert.equal(percentOf(49900, 2000), 9980);
  assert.equal(percentOf(1, 2000), 0);
  assert.equal(percentOf(3, 2000), 1); // 0.6 → 1
});

test('formatEuro uses Austrian format in German', () => {
  assert.equal(formatEuro(12900, 'de').replace(/\s/g, ' '), '€ 129,00');
  assert.equal(formatEuro(12900, 'en'), '€129.00');
});

test('formatRate', () => {
  assert.equal(formatRate(2000, 'de'), '20 %');
  assert.equal(formatRate(2550, 'de'), '25,5 %');
  assert.equal(formatRate(1900, 'en'), '19%');
});

test('vatFor: OSS off → Austrian VAT for every EU country', () => {
  assert.deepEqual(vatFor({ country: 'AT', ossEnabled: false }), {
    rate: 2000,
    taxCountry: 'AT',
    regime: 'domestic',
  });
  assert.deepEqual(vatFor({ country: 'DE', ossEnabled: false }), {
    rate: 2000,
    taxCountry: 'AT',
    regime: 'domestic',
  });
});

test('vatFor: OSS on → destination rate, Austria stays domestic', () => {
  assert.equal(vatFor({ country: 'DE', ossEnabled: true }).rate, 1900);
  assert.equal(vatFor({ country: 'de', ossEnabled: true }).regime, 'oss');
  assert.equal(vatFor({ country: 'AT', ossEnabled: true }).regime, 'domestic');
});

test('vatFor: rates from the admin table win over seed values', () => {
  assert.equal(vatFor({ country: 'DE', ossEnabled: true, rates: { DE: 2000 } }).rate, 2000);
});

test('vatFor: non-EU destination is a tax-free export', () => {
  assert.deepEqual(vatFor({ country: 'CH', ossEnabled: false }), {
    rate: 0,
    taxCountry: null,
    regime: 'export',
  });
});

test('orderVat: one rate on the order total incl. shipping', () => {
  const b = orderVat([{ gross: 12900 }, { gross: 2580 }], { country: 'AT', ossEnabled: false });
  assert.equal(b.gross, 15480);
  assert.equal(b.vat, 2580);
  assert.equal(b.net, 12900);
});
