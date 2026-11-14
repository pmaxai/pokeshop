import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import {
  decodeSeries,
  packLang,
  printingFor,
  printings,
  unitValue,
  type PackCard,
} from '../src/pack-cards.ts';
import { safeNextPath } from '../src/accounts.ts';

const prices = (p: Partial<Record<string, number | null>>) => ({
  trend: null,
  avg: null,
  low: null,
  avg30: null,
  trend_holo: null,
  avg_holo: null,
  low_holo: null,
  avg30_holo: null,
  updated: null,
  ...p,
});

test('printings: TCGplayer decides which printings exist, Cardmarket holo columns are the reverse', () => {
  const list = printings({
    variants: { normal: true, reverse: true },
    rarity: 'Common',
    prices: prices({ trend: 0.5, avg30: 0.4, low: 0.02, trend_holo: 1.2 }),
    tcgplayer: { normal: { marketPrice: 0.3 }, 'reverse-holofoil': { marketPrice: 1.1 } },
    usdPerEur: 1.1,
  });
  assert.deepEqual(
    list.map((p) => [p.kind, p.eur, p.usd, p.value]),
    [
      ['normal', 0.5, 0.3, 0.5],
      ['reverse', 1.2, 1.1, 1.2],
    ],
  );
});

test('printings: a holo without a normal printing takes Cardmarket’s standard price', () => {
  const list = printings({
    variants: { holo: true, firstEdition: true },
    rarity: 'Rare Holo',
    prices: prices({ trend: 385.83, avg30: 407.53, low: 90 }),
    tcgplayer: { holofoil: { marketPrice: 987.13 } },
    usdPerEur: 1.1052,
  });
  assert.equal(list[0]!.kind, 'holo');
  assert.equal(list[0]!.eur, 385.83);
  assert.equal(list[0]!.usdEur, 893.17);
  assert.equal(list[1]!.kind, 'first');
  assert.equal(list[1]!.value, null);
});

test('printings: without Cardmarket the value is TCGplayer in euros', () => {
  const [p] = printings({
    variants: null,
    rarity: 'Common',
    prices: null,
    tcgplayer: { normal: { marketPrice: 2.2 } },
    usdPerEur: 1.1,
  });
  assert.equal(p!.value, 2);
});

const card = (over: Partial<PackCard> = {}): PackCard => ({
  id: 'base1-4',
  lang: 'en',
  name: 'Charizard',
  names: { en: 'Charizard' },
  setId: 'base1',
  setName: 'Base Set',
  series: 'Base',
  number: '4/102',
  localId: '4',
  releaseDate: '1999-01-09',
  rarity: 'Rare',
  category: 'Pokemon',
  image: null,
  printings: printings({
    variants: { holo: true },
    rarity: 'Rare Holo',
    prices: prices({ trend: 400 }),
    tcgplayer: null,
    usdPerEur: 1.25,
  }),
  priceCheck: null,
  graded: {
    holo: { psa10: 7500, psa10n: 3, psa9: 2500, psa9n: 9, psa8: null, psa8n: null, updated: null },
  },
  pricesUpdated: null,
  usdPerEur: 1.25,
  ...over,
});

test('unitValue: condition factors and PSA prices', () => {
  const c = card();
  assert.equal(unitValue(c, { finish: 'holo', condition: 'NM' }), 400);
  assert.equal(unitValue(c, { finish: 'holo', condition: 'EX' }), 340);
  assert.equal(unitValue(c, { finish: 'holo', condition: 'PO' }), 120);
  // a finish the card doesn't have falls back to its first printing, like the app
  assert.equal(printingFor(c, 'reverse_holo')!.kind, 'holo');
  assert.equal(unitValue(c, { finish: 'holo', grading: { company: 'PSA', grade: '10' } }), 6000);
  assert.equal(unitValue(c, { finish: 'holo', grading: { company: 'PSA', grade: '8' } }), null);
  assert.equal(unitValue(c, { finish: 'holo', grading: { company: 'CGC', grade: '10' } }), null);
});

test('packLang maps shop languages to the pack’s names (Korean = Japanese)', () => {
  assert.equal(packLang('DE'), 'de');
  assert.equal(packLang('KO'), 'ja');
  assert.equal(packLang('ZH-HANT'), 'zh-tw');
  assert.equal(packLang('FR'), 'en');
});

test('decodeSeries reads float16 and float32 series with gaps', () => {
  const f16 = Buffer.alloc(6);
  f16.writeUInt16LE(0x3c00, 0); // 1
  f16.writeUInt16LE(0x7e00, 2); // NaN
  f16.writeUInt16LE(0x4900, 4); // 10
  assert.deepEqual(decodeSeries(deflateSync(f16), 3), [1, null, 10]);
  const f32 = Buffer.alloc(8);
  f32.writeFloatLE(70000.5, 0);
  f32.writeFloatLE(NaN, 4);
  assert.deepEqual(decodeSeries(deflateSync(f32), 2), [70000.5, null]);
});

test('safeNextPath keeps only paths of this site', () => {
  assert.equal(safeNextPath('/de/konto'), '/de/konto');
  assert.equal(safeNextPath('/checkout?x=1'), '/checkout?x=1');
  assert.equal(safeNextPath('//evil.example'), null);
  assert.equal(safeNextPath('/\\evil.example'), null);
  assert.equal(safeNextPath('https://evil.example'), null);
  assert.equal(safeNextPath('/a\nb'), null);
  assert.equal(safeNextPath(''), null);
});
