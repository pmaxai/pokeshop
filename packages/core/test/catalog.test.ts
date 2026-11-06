import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSku,
  cardNames,
  cardNameText,
  compareStorageLocations,
  isStorageLocation,
  localCardNumber,
  productSlug,
} from '../src/catalog.ts';

test('buildSku follows set · number · language · condition · finish', () => {
  assert.equal(
    buildSku({
      setCode: 'sv03.5',
      cardNumber: '199/165',
      language: 'DE',
      condition: 'NM',
      finish: 'holo',
    }),
    'sv03.5-199-DE-NM-H',
  );
});

test('buildSku appends grading company and grade', () => {
  assert.equal(
    buildSku({
      setCode: 'base1',
      cardNumber: '4/102',
      language: 'EN',
      condition: 'NM',
      finish: 'first_edition',
      grading: { company: 'PSA', grade: '10' },
    }),
    'base1-4-EN-NM-1E-PSA10',
  );
  assert.equal(
    buildSku({
      setCode: 'swsh12',
      cardNumber: 'TG05/TG30',
      language: 'JA',
      condition: 'M',
      finish: 'normal',
      grading: { company: 'BGS', grade: '9.5' },
    }),
    'swsh12-TG05-JA-M-N-BGS9.5',
  );
});

test('localCardNumber keeps only the own part', () => {
  assert.equal(localCardNumber('199/165'), '199');
  assert.equal(localCardNumber(' SWSH050 '), 'SWSH050');
});

test('storage_location: digits only, at least three', () => {
  for (const ok of ['001', '014', '999', '1203']) assert.ok(isStorageLocation(ok), ok);
  for (const bad of ['1', '01', 'A01', '01-2', '', ' 001', 14, null]) {
    assert.equal(isStorageLocation(bad), false, String(bad));
  }
});

test('boxes sort numerically', () => {
  const boxes = ['100', '014', '1203', '002', '099'];
  assert.deepEqual(boxes.sort(compareStorageLocations), ['002', '014', '099', '100', '1203']);
});

test('productSlug is URL-safe and unique per SKU', () => {
  assert.equal(
    productSlug('Glurak-ex', 'sv03.5', 'sv03.5-199-DE-NM-H'),
    'glurak-ex-sv03-5-199-de-nm-h',
  );
  assert.equal(productSlug('Flabébé', 'sv04', 'sv04-1-FR-EX-R'), 'flabebe-sv04-1-fr-ex-r');
});

const charizard = { nameDe: 'Glurak-ex', nameEn: 'Charizard ex' };
const show = (n: ReturnType<typeof cardNames>) => [
  n.original,
  ...n.translations.map((t) => t.text),
];

test('the printed name leads in every shop language', () => {
  // English card: English name, German below only in the German shop
  assert.deepEqual(show(cardNames({ ...charizard, cardLanguage: 'EN' }, 'de')), [
    'Charizard ex',
    'Glurak-ex',
  ]);
  assert.deepEqual(show(cardNames({ ...charizard, cardLanguage: 'EN' }, 'en')), ['Charizard ex']);
  // German card: German name, English below in both shops
  assert.deepEqual(show(cardNames({ ...charizard, cardLanguage: 'DE' }, 'de')), [
    'Glurak-ex',
    'Charizard ex',
  ]);
  assert.deepEqual(show(cardNames({ ...charizard, cardLanguage: 'DE' }, 'en')), [
    'Glurak-ex',
    'Charizard ex',
  ]);
  // Japanese card: Japanese name, then English, then German (German shop)
  const ja = cardNames({ ...charizard, cardLanguage: 'JA', nameLocal: 'リザードンex' }, 'de');
  assert.deepEqual(show(ja), ['リザードンex', 'Charizard ex', 'Glurak-ex']);
  assert.equal(ja.lang, 'ja');
  assert.deepEqual(
    ja.translations.map((t) => t.lang),
    ['en', 'de'],
  );
  assert.equal(cardNameText(ja), 'リザードンex (Charizard ex, Glurak-ex)');
  assert.deepEqual(
    show(cardNames({ ...charizard, cardLanguage: 'ZH-HANT', nameLocal: '噴火龍ex' }, 'en')),
    ['噴火龍ex', 'Charizard ex'],
  );
  assert.equal(
    cardNames({ ...charizard, cardLanguage: 'ZH-HANT', nameLocal: '噴火龍ex' }, 'en').lang,
    'zh-Hant',
  );
});

test('names that only differ in spelling are not repeated', () => {
  // Italian "Charizard-ex" is the English name with a hyphen
  assert.deepEqual(
    show(cardNames({ ...charizard, cardLanguage: 'IT', nameLocal: 'Charizard-ex' }, 'de')),
    ['Charizard-ex', 'Glurak-ex'],
  );
  // a Pokémon with the same name in German and English
  assert.deepEqual(
    show(
      cardNames(
        { nameDe: 'Pikachu', nameEn: 'Pikachu', cardLanguage: 'FR', nameLocal: 'Pikachu' },
        'de',
      ),
    ),
    ['Pikachu'],
  );
});

test('without a known printed name the English one leads', () => {
  const n = cardNames({ ...charizard, cardLanguage: 'KO', nameLocal: null }, 'de');
  assert.deepEqual(show(n), ['Charizard ex', 'Glurak-ex']);
  assert.equal(n.lang, 'en');
  // DE/EN cards never use name_local
  assert.equal(
    cardNames({ ...charizard, cardLanguage: 'EN', nameLocal: 'Dracaufeu-ex' }, 'en').original,
    'Charizard ex',
  );
});
