import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocate,
  asVoucherCode,
  licenseDiscount,
  newDiscountCode,
  newVoucherCode,
  priceCards,
  VOUCHER_CODE,
  type DiscountCodeRow,
  type VoucherRow,
} from '../src/vouchers.ts';

const code = (over: Partial<DiscountCodeRow>): DiscountCodeRow => ({
  id: 1,
  code: 'TEST',
  campaign: null,
  kind: 'percent',
  percent_bp: 2000,
  amount_cents: null,
  applies_to: 'both',
  min_goods_cents: 0,
  max_licenses: null,
  max_uses: null,
  once_per_customer: false,
  valid_from: null,
  valid_until: null,
  active: true,
  ...over,
});
const voucher = (id: number, origin: 'sold' | 'promo', balance: number): VoucherRow => ({
  id,
  code: `V${id}`,
  origin,
  value_cents: balance,
  balance_cents: balance,
  status: 'active',
  expires_at: null,
});

test('codes: readable alphabet, voucher codes recognised however they are typed', () => {
  for (let i = 0; i < 200; i++) {
    const c = newVoucherCode();
    assert.match(c, VOUCHER_CODE);
    assert.doesNotMatch(c, /[01OIL]/);
  }
  assert.match(newDiscountCode('freund'), /^FREUND-[A-Z0-9]{6}$/);
  assert.equal(asVoucherCode('abcd efgh jkmn'), 'ABCD-EFGH-JKMN');
  assert.equal(asVoucherCode('ABCD-EFGH-JKMN'), 'ABCD-EFGH-JKMN');
  assert.equal(asVoucherCode('CHRISTMAS'), null);
});

test('allocate spreads a discount exactly over the lines', () => {
  assert.deepEqual(allocate(100, [1000, 500]), [67, 33]);
  assert.deepEqual(allocate(1, [1, 1, 1]), [1, 0, 0]);
  assert.deepEqual(allocate(0, [5, 5]), [0, 0]);
  const parts = allocate(997, [333, 333, 334]);
  assert.equal(
    parts.reduce((a, b) => a + b, 0),
    997,
  );
});

test('pricing: code on the cards, promotional vouchers on cards and shipping, bought ones pay', () => {
  const p = priceCards({
    lines: [2000, 500],
    shipping: 450,
    code: code({ percent_bp: 2000 }),
    vouchers: [voucher(1, 'sold', 1000), voucher(2, 'promo', 2500)],
  });
  assert.equal(p.code!.amount, 500);
  assert.deepEqual(
    p.promo,
    [{ voucherId: 2, code: 'V2', amount: 2450 }],
    'promo first, whatever the order',
  );
  assert.equal(p.shippingDiscount, 450);
  assert.equal(p.total, 0);
  assert.deepEqual(p.paid, [], 'nothing left to pay with the bought voucher');
  assert.equal(p.due, 0);

  const q = priceCards({
    lines: [3000],
    shipping: 500,
    code: code({ kind: 'amount', percent_bp: null, amount_cents: 5000 }),
    vouchers: [],
  });
  assert.equal(q.code!.amount, 3000, 'an amount code never goes below the cards’ value');
  assert.equal(q.total, 500, 'shipping is still owed');
});

test('pricing: Stripe’s € 0.50 minimum is left to pay rather than a few cents', () => {
  const p = priceCards({
    lines: [1020],
    shipping: 0,
    code: null,
    vouchers: [voucher(1, 'sold', 1000)],
  });
  assert.equal(p.paid[0]!.amount, 970);
  assert.equal(p.due, 50);
  const free = priceCards({
    lines: [1000],
    shipping: 0,
    code: null,
    vouchers: [voucher(1, 'sold', 1000)],
  });
  assert.equal(free.due, 0);
  const promo = priceCards({
    lines: [1010],
    shipping: 0,
    code: null,
    vouchers: [voucher(1, 'promo', 1000)],
  });
  assert.equal(promo.due, 50);
  assert.equal(promo.discount, 960);
  assert.deepEqual(promo.lineDiscounts, [960]);
});

test('licences: percent on at most N licences, never a few cents left', () => {
  assert.equal(licenseDiscount(code({ percent_bp: 10_000, max_licenses: 1 }), 13900, 3), 13900);
  assert.equal(licenseDiscount(code({ percent_bp: 2000 }), 13900, 2), 5560);
  assert.equal(
    licenseDiscount(code({ kind: 'amount', percent_bp: null, amount_cents: 13880 }), 13900, 1),
    13850,
  );
  assert.equal(
    licenseDiscount(code({ kind: 'amount', percent_bp: null, amount_cents: 99_999 }), 13900, 1),
    13900,
  );
});
