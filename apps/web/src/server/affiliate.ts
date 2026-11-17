import 'server-only';
import { cookies } from 'next/headers';
import {
  affiliateDiscount,
  affiliateLinkByCode,
  normalizeAffiliateCode,
  registerAffiliate,
  type AffiliateDiscount,
  type AffiliateLink,
  type AffiliateVia,
  type RegisterResult,
} from '@pokeshop/core/affiliates';
import { db } from './config';

/** The code of the affiliate link a visitor came with (/r/<code>), for 90 days. */
export const AFF_COOKIE = 'oc_ref';
export const AFF_COOKIE_DAYS = 90;

/** The link of the code in the visitor's cookie, if it is still active. */
export async function cookieAffiliate(): Promise<AffiliateLink | null> {
  const code = normalizeAffiliateCode((await cookies()).get(AFF_COOKIE)?.value);
  return code ? affiliateLinkByCode(db(), code) : null;
}

/** After a login on the website: the account takes the cookie's code (if it still can). */
export async function registerFromCookie(accountId: number): Promise<void> {
  const link = await cookieAffiliate();
  if (link) await registerAffiliate(db(), { accountId, code: link.code, via: 'link' });
}

/** The app API's view of an account's discount (null: none). */
export function discountJson(d: AffiliateDiscount | null) {
  return d
    ? {
        code: d.code,
        discount_percent: d.percent,
        discount_months: d.months,
        google_offer_id: d.googleOfferId,
        // App Store: the custom offer code to redeem in Apple's sheet
        apple_offer_code: d.appleOfferCode,
      }
    : null;
}

/**
 * The app sent a code (install referrer or typed in): register the account and say what came of
 * it. Never fails the request it rides on.
 */
export async function applyAppCode(
  accountId: number,
  code: unknown,
  via: AffiliateVia = 'app',
): Promise<{
  result: 'applied' | Extract<RegisterResult, { ok: false }>['problem'];
  affiliate: ReturnType<typeof discountJson>;
}> {
  const c = normalizeAffiliateCode(code);
  const r = c
    ? await registerAffiliate(db(), { accountId, code: c, via })
    : ({ ok: false, problem: 'unknown_code' } as const);
  return {
    result: r.ok ? 'applied' : r.problem,
    affiliate: discountJson(await affiliateDiscount(db(), accountId)),
  };
}
