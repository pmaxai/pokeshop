'use server';

import { redirect } from 'next/navigation';
import { saveAffiliate, saveAffiliateLink } from '@pokeshop/core/affiliates';
import { db } from '@/server/config';
import { audit, requireAdmin } from '@/server/admin-auth';

const PAGE = '/admin/affiliates';

const back = (notice: string, err = false, hash = ''): never =>
  redirect(`${PAGE}?${err ? 'err' : 'ok'}=${encodeURIComponent(notice)}${hash ? `#${hash}` : ''}`);

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

const FIELDS: Record<string, string> = {
  name: 'Name',
  email: 'E-Mail',
  country: 'Land',
  commission: 'Vergütung',
  payoutDetails: 'Auszahlung',
  note: 'Notiz',
  code: 'Code',
  label: 'Bezeichnung',
  discountPercent: 'Rabatt',
  discountMonths: 'Monate',
  googleOfferId: 'Play-Angebot',
  affiliateId: 'Influencer',
};
const explain = (errors: Record<string, string>) =>
  Object.entries(errors)
    .map(([k, v]) =>
      v === 'taken'
        ? 'Diesen Code gibt es schon'
        : v === 'without_discount'
          ? 'Monate nur mit Rabatt'
          : `${FIELDS[k] ?? k}: ${v === 'required' ? 'fehlt' : 'bitte prüfen'}`,
    )
    .join(', ');

/** An influencer: new, or edited (id). */
export async function saveAffiliateAction(form: FormData) {
  const user = await requireAdmin('owner');
  const id = Number(str(form, 'id')) || undefined;
  const input = {
    name: str(form, 'name'),
    email: str(form, 'email'),
    country: str(form, 'country'),
    commission: str(form, 'commission'),
    payoutDetails: str(form, 'payout_details'),
    note: str(form, 'note'),
    active: id ? str(form, 'active') === 'on' : true,
  };
  const r = await saveAffiliate(db(), input, id);
  if (!r.ok) back(`Nicht gespeichert: ${explain(r.errors)}`, true);
  const saved = r as { ok: true; id: number };
  await audit(
    user,
    id ? 'affiliate.update' : 'affiliate.create',
    'affiliate',
    saved.id,
    null,
    input,
  );
  back(id ? 'Influencer gespeichert.' : 'Influencer angelegt.', false, `aff-${saved.id}`);
}

/** A link of an influencer: new, or edited (id). */
export async function saveAffiliateLinkAction(form: FormData) {
  const user = await requireAdmin('owner');
  const id = Number(str(form, 'id')) || undefined;
  const affiliateId = Number(str(form, 'affiliate_id'));
  const input = {
    affiliateId,
    code: str(form, 'code'),
    label: str(form, 'label'),
    discountPercent: str(form, 'discount_percent') || '0',
    discountMonths: str(form, 'discount_months'),
    googleOfferId: str(form, 'google_offer_id'),
    active: id ? str(form, 'active') === 'on' : true,
  };
  const r = await saveAffiliateLink(db(), input, id);
  if (!r.ok) back(`Link nicht gespeichert: ${explain(r.errors)}`, true, `aff-${affiliateId}`);
  const saved = r as { ok: true; id: number };
  await audit(
    user,
    id ? 'affiliate_link.update' : 'affiliate_link.create',
    'affiliate_link',
    saved.id,
    null,
    input,
  );
  back(id ? 'Link gespeichert.' : 'Link angelegt.', false, `aff-${affiliateId}`);
}
