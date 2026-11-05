import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.ts';
import { syncCardDetails, syncSets, type TcgdexClient } from '../../src/tcgdex.ts';
import type { Sql } from '../../src/db.ts';

let sql: Sql;
let drop: () => Promise<void>;
before(async () => ({ sql, drop } = await freshDatabase()));
after(async () => drop());

// Shapes copied from real TCGdex responses (trimmed).
const fake: TcgdexClient = {
  async sets(lang) {
    return lang === 'de'
      ? [{ id: 'sv03.5', name: '151' }]
      : [
          { id: 'sv03.5', name: '151' },
          { id: 'A1', name: 'Genetic Apex' },
        ];
  },
  async set(lang, id) {
    if (id === 'A1') {
      return {
        id,
        name: 'Genetic Apex',
        serie: { id: 'tcgp', name: 'Pokémon TCG Pocket' },
        cards: [],
      };
    }
    return {
      id,
      name: '151',
      releaseDate: '2023-09-22',
      logo: `https://assets.tcgdex.net/${lang}/sv/sv03.5/logo`,
      serie: { id: 'sv', name: lang === 'de' ? 'Karmesin & Purpur' : 'Scarlet & Violet' },
      cardCount: { official: 165, total: 207 },
      cards: [
        {
          id: 'sv03.5-199',
          localId: '199',
          name: lang === 'de' ? 'Glurak-ex' : 'Charizard ex',
          image: `https://assets.tcgdex.net/${lang}/sv/sv03.5/199`,
        },
      ],
    };
  },
  async card(lang, id) {
    if (id !== 'sv03.5-199') return null;
    return {
      id,
      localId: '199',
      name: lang === 'de' ? 'Glurak-ex' : 'Charizard ex',
      category: lang === 'de' ? 'Pokémon' : 'Pokemon',
      rarity: lang === 'de' ? 'Selten, besondere Illustration' : 'Special illustration rare',
      types: lang === 'de' ? ['Feuer'] : ['Fire'],
      set: { id: 'sv03.5' },
    };
  },
};

test('sync stores sets and card names in both languages and skips TCG Pocket', async () => {
  const report = await syncSets(sql, fake);
  assert.deepEqual(report, { sets: 1, cards: 1, skipped: ['A1'] });
  const [set] = await sql`SELECT * FROM card_sets WHERE set_code = 'sv03.5'`;
  assert.equal(set?.series_de, 'Karmesin & Purpur');
  assert.equal(set?.series_en, 'Scarlet & Violet');
  assert.equal(set?.card_count, 165);
  const [card] = await sql`SELECT * FROM card_master WHERE card_ref = 'sv03.5-199'`;
  assert.equal(card?.name_de, 'Glurak-ex');
  assert.equal(card?.name_en, 'Charizard ex');
  // running it again changes nothing
  assert.equal((await syncSets(sql, fake)).cards, 1);
});

test('card details give canonical English values and German labels', async () => {
  const row = await syncCardDetails(sql, fake, 'sv03.5-199');
  assert.equal(row?.rarity, 'Special illustration rare');
  assert.equal(row?.rarity_de, 'Selten, besondere Illustration');
  assert.equal(row?.supertype, 'pokemon');
  assert.deepEqual(row?.energy_types, ['Fire']);
  const [label] =
    await sql`SELECT label_de FROM rarity_labels WHERE rarity = 'Special illustration rare'`;
  assert.equal(label?.label_de, 'Selten, besondere Illustration');
  assert.equal(await syncCardDetails(sql, fake, 'xx-1'), null);
});
