'use server';

import { redirect } from 'next/navigation';
import { createOffer, withdrawOffer } from '@pokeshop/core/wanted';
import { db } from '@/server/config';
import { audit, requireAdmin } from '@/server/admin-auth';

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const back = (card: string, notice: string, err = false): never =>
  redirect(
    `/admin/gesucht/${encodeURIComponent(card)}?${err ? 'err' : 'ok'}=${encodeURIComponent(notice)}`,
  );

/** "120" / "89,90" → cents; anything else → NaN (rejected by the check). */
const cents = (v: string) => Math.round(Number(v.replace(/\s/g, '').replace(',', '.')) * 100);

const ERRORS: Record<string, string> = {
  wantedId: 'Der Kunde hat die Karte nicht mehr auf der Liste.',
  productId: 'Das Produkt passt nicht zur Karte oder ist nicht mehr da.',
  priceCents: 'Bitte einen Preis in Euro, z. B. 120 oder 89,90.',
  days: 'Gültigkeit: 1 bis 60 Tage.',
  message: 'Die Nachricht ist zu lang (höchstens 1000 Zeichen).',
};

export async function createOfferAction(form: FormData) {
  const user = await requireAdmin();
  const card = str(form, 'card_id');
  const input = {
    wantedId: str(form, 'wanted_id'),
    productId: str(form, 'product_id'),
    priceCents: cents(str(form, 'price')),
    days: str(form, 'days') || '7',
    message: str(form, 'message'),
  };
  const r = await createOffer(db(), input, { by: user.email });
  if (!r.ok) {
    const k = Object.keys(r.errors)[0] ?? '';
    back(
      card,
      r.errors.productId === 'sold'
        ? 'Von diesem Produkt ist kein Exemplar mehr frei.'
        : (ERRORS[k] ?? 'Angebot nicht gespeichert.'),
      true,
    );
  }
  await audit(user, 'wanted.offer', 'wanted_offer', r.ok ? r.offerId : 0, null, input);
  back(card, 'Angebot gesendet. Der Kunde bekommt eine E-Mail.');
}

export async function withdrawOfferAction(form: FormData) {
  const user = await requireAdmin();
  const card = str(form, 'card_id');
  const id = Number(str(form, 'id'));
  const done = await withdrawOffer(db(), id);
  if (done) await audit(user, 'wanted.offer_withdrawn', 'wanted_offer', id, null, null);
  back(card, done ? 'Angebot zurückgezogen.' : 'Das Angebot war nicht mehr offen.', !done);
}
