import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteShipping, type CountryShippingSettings } from '../src/shipping.ts';
import { checkCheckout, type CartLine } from '../src/checkout.ts';

const AT: CountryShippingSettings = {
  code: 'AT',
  deliveryEnabled: true,
  minOrder: 1000,
  standardShipping: 0,
  insuredRate: 2000,
  insuredMinimum: 500,
  insuredMaxOrder: 50000,
  insuredMaxCharge: null,
};
const DE: CountryShippingSettings = { ...AT, code: 'DE', minOrder: 2000 };

test('no high-value card → free standard shipping', () => {
  assert.deepEqual(quoteShipping({ goodsSubtotal: 30000, hasHighValue: false, country: AT }), {
    method: 'standard',
    price: 0,
  });
});

test('high-value card → insured, 20 % of the subtotal', () => {
  assert.deepEqual(quoteShipping({ goodsSubtotal: 12900, hasHighValue: true, country: AT }), {
    method: 'insured',
    price: 2580,
  });
});

test('insured shipping costs at least € 5', () => {
  assert.equal(quoteShipping({ goodsSubtotal: 1500, hasHighValue: true, country: AT }).price, 500);
});

test('exactly € 500 is still insured; above € 500 ships tracked without insurance or charge', () => {
  assert.deepEqual(quoteShipping({ goodsSubtotal: 50000, hasHighValue: true, country: AT }), {
    method: 'insured',
    price: 10000,
  });
  assert.deepEqual(quoteShipping({ goodsSubtotal: 50001, hasHighValue: true, country: AT }), {
    method: 'tracked',
    price: 0,
  });
  assert.deepEqual(quoteShipping({ goodsSubtotal: 900000, hasHighValue: true, country: AT }), {
    method: 'tracked',
    price: 0,
  });
});

test('optional cap on the insured charge', () => {
  const capped = { ...AT, insuredMaxCharge: 2500 };
  assert.equal(
    quoteShipping({ goodsSubtotal: 49900, hasHighValue: true, country: capped }).price,
    2500,
  );
});

const line = (over: Partial<CartLine> = {}): CartLine => ({
  productId: 1,
  quantity: 1,
  unitPrice: 1200,
  highValue: false,
  available: 1,
  active: true,
  ...over,
});

test('checkout: Austria with € 12 passes the € 10 minimum', () => {
  const r = checkCheckout({ lines: [line()], country: AT, countryCode: 'AT' });
  assert.equal(r.ok, true);
  assert.equal(r.total, 1200);
});

test('checkout: Germany with € 12 is € 8 below the € 20 minimum', () => {
  const r = checkCheckout({ lines: [line()], country: DE, countryCode: 'DE' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, [{ code: 'below_minimum', minimum: 2000, missing: 800 }]);
});

test('checkout: country switched off or unknown', () => {
  const off = { ...AT, code: 'FR', deliveryEnabled: false };
  assert.deepEqual(checkCheckout({ lines: [line()], country: off, countryCode: 'FR' }).problems, [
    { code: 'country_not_delivered', country: 'FR' },
  ]);
  assert.equal(checkCheckout({ lines: [line()], country: null, countryCode: 'US' }).ok, false);
});

test('checkout: card sold in the meantime or archived', () => {
  const r = checkCheckout({
    lines: [line({ productId: 7, available: 0 }), line({ productId: 8, active: false })],
    country: AT,
    countryCode: 'AT',
  });
  assert.deepEqual(
    r.problems.map((p) => p.code),
    ['unavailable', 'unavailable'],
  );
});

test('checkout: high-value card adds the insured charge to the total', () => {
  const r = checkCheckout({
    lines: [line({ unitPrice: 12900, highValue: true })],
    country: AT,
    countryCode: 'AT',
  });
  assert.equal(r.shipping?.method, 'insured');
  assert.equal(r.total, 12900 + 2580);
});

test('checkout: empty cart and bad quantity', () => {
  assert.deepEqual(checkCheckout({ lines: [], country: AT, countryCode: 'AT' }).problems[0], {
    code: 'empty_cart',
  });
  const bad = checkCheckout({ lines: [line({ quantity: 0 })], country: AT, countryCode: 'AT' });
  assert.equal(bad.problems[0]?.code, 'invalid_quantity');
});
