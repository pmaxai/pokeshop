import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localePath } from '../src/locale-paths.ts';
import { fillPlaceholders } from '../src/legal.ts';

test('English sits at the root, German under /de', () => {
  assert.equal(localePath('en', { de: '/bestellung/x', en: '/order/x' }), '/order/x');
  assert.equal(localePath('de', { de: '/bestellung/x', en: '/order/x' }), '/de/bestellung/x');
  assert.equal(localePath('de', { de: '/', en: '/' }), '/de');
  assert.equal(localePath('en', { de: '/', en: '/' }), '/');
});

test('legal texts link to the page in their own language', () => {
  const ctx = { company: {}, baseUrl: 'https://shop.test' };
  const md = '{{terms_url}} {{shipping_url}} {{app_url}}';
  assert.equal(
    fillPlaceholders(md, { ...ctx, locale: 'en' }),
    'https://shop.test/terms https://shop.test/shipping-and-payment https://shop.test/app',
  );
  assert.equal(
    fillPlaceholders(md, { ...ctx, locale: 'de' }),
    'https://shop.test/de/agb https://shop.test/de/versand-und-zahlung https://shop.test/de/app',
  );
});
