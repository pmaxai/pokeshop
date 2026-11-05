import { randomInt } from 'node:crypto';

/** Unambiguous characters for numbers customers type: no 0/O, 1/I/L. */
const ORDER_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Order number customers see and type into the order-status and withdrawal
 * forms, e.g. "PK-2611-7KQ4M". Random part keeps numbers unguessable; the
 * database's unique constraint catches the (rare) collision and the caller retries.
 */
export function newOrderNumber(now: Date, random: (max: number) => number = randomInt): string {
  const yy = String(now.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  let tail = '';
  for (let i = 0; i < 5; i++) tail += ORDER_ALPHABET[random(ORDER_ALPHABET.length)];
  return `PK-${yy}${mm}-${tail}`;
}

export type DocumentKind = 'invoice' | 'credit_note';

const PREFIX: Record<DocumentKind, string> = { invoice: 'RE', credit_note: 'GS' };

/** Gap-free invoice and credit-note numbers per year: RE-2026-000123, GS-2026-000017. */
export function formatDocumentNumber(kind: DocumentKind, year: number, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) throw new RangeError('sequence must start at 1');
  return `${PREFIX[kind]}-${year}-${String(seq).padStart(6, '0')}`;
}
