import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillPlaceholders, legalHtml } from '../src/legal.ts';

const ctx = {
  company: {
    name: 'Antalyse GmbH',
    street: 'Wienerstraße 1',
    postcode: '2440',
    city: 'Moosbrunn',
    country: 'AT',
    email: 'bestellung@pokemonkarten.at',
  },
  baseUrl: 'https://pokemonkarten.at',
  locale: 'de' as const,
};

test('placeholders: company, address and shop links per language', () => {
  const md = '{{company.name}}, {{company.address}} – {{withdraw_url}} {{unknown}}';
  assert.equal(
    fillPlaceholders(md, ctx),
    'Antalyse GmbH, Wienerstraße 1, 2440 Moosbrunn, Österreich – https://pokemonkarten.at/vertrag-widerrufen {{unknown}}',
  );
  assert.match(fillPlaceholders('{{withdraw_url}}', { ...ctx, locale: 'en' }), /\/en\/withdraw$/);
});

test('raw HTML in a legal text is shown as text, never rendered', () => {
  const html = legalHtml('Hallo <script>alert(1)</script> **fett**', ctx);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>fett<\/strong>/);
});
