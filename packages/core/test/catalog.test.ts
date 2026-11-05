import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSku,
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
