// Business buyers' VAT ids: format per EU country, and the live check against VIES (the EU
// Commission's VAT Information Exchange System).
import { isEuCountry } from './vat.ts';

/** Licences are sold in the EU only, to private persons and businesses alike. */
export const licenseCountryAllowed = (country: string): boolean => isEuCountry(country);

/** VIES and VAT ids use EL for Greece. */
export const vatPrefix = (country: string) => (country === 'GR' ? 'EL' : country);

/** EU VAT id formats after the country prefix (the usual national structures). */
const EU_VAT: Record<string, RegExp> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^\d[A-Z0-9+*]\d{5}[A-Z]{1,2}$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
};

export type TaxId = {
  /** Stripe's tax id type: always eu_vat. */
  type: 'eu_vat';
  /** Normalised as Stripe expects it: prefix and number, no spaces or dots. */
  value: string;
};

/**
 * Reads what the buyer typed as a VAT id of their EU country. Returns null when it cannot be
 * one: not an EU country, wrong country prefix or wrong format.
 */
export function parseTaxId(country: string, raw: string): TaxId | null {
  const compact = raw.toUpperCase().replace(/[\s.\-/]/g, '');
  if (!compact || !isEuCountry(country)) return null;
  const prefix = vatPrefix(country);
  // Typed with or without the prefix; another country's prefix fails the format check.
  const number = compact.startsWith(prefix) ? compact.slice(prefix.length) : compact;
  return EU_VAT[prefix]?.test(number) ? { type: 'eu_vat', value: `${prefix}${number}` } : null;
}

// ---------------------------------------------------------------------------
// VIES
// ---------------------------------------------------------------------------

export type ViesResult =
  | { status: 'valid'; name: string | null; address: string | null }
  | { status: 'invalid' }
  /** The member state's service or VIES itself did not answer: ask again later. */
  | { status: 'unavailable'; error: string };

export type ViesChecker = (vatId: string) => Promise<ViesResult>;

const VIES_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms';

const clean = (v: unknown) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s !== '---' ? s : null;
};

/**
 * Checks an EU VAT id (prefix + number, e.g. DE123456789) with the VIES REST service.
 * Anything other than a clear yes or no counts as unavailable.
 */
export function viesChecker(opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): ViesChecker {
  const doFetch = opts.fetch ?? fetch;
  return async (vatId) => {
    const prefix = vatId.slice(0, 2);
    const number = vatId.slice(2);
    let body: Record<string, unknown>;
    try {
      const res = await doFetch(
        `${VIES_URL}/${encodeURIComponent(prefix)}/vat/${encodeURIComponent(number)}`,
        {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        },
      );
      body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok && typeof body.isValid !== 'boolean') {
        return {
          status: 'unavailable',
          error: `VIES ${res.status} ${viesError(body) ?? ''}`.trim(),
        };
      }
    } catch (e) {
      return { status: 'unavailable', error: (e as Error).message };
    }
    const valid = typeof body.isValid === 'boolean' ? body.isValid : body.valid;
    const error = viesError(body);
    if (valid === true) {
      return { status: 'valid', name: clean(body.name), address: clean(body.address) };
    }
    if (valid === false && (!error || error === 'VALID' || error === 'INVALID')) {
      return { status: 'invalid' };
    }
    if (error === 'INVALID_INPUT') return { status: 'invalid' };
    return { status: 'unavailable', error: error ?? 'unexpected VIES answer' };
  };
}

function viesError(body: Record<string, unknown>): string | null {
  if (typeof body.userError === 'string') return body.userError;
  const w = body.errorWrappers;
  if (Array.isArray(w) && w[0] && typeof (w[0] as { error?: unknown }).error === 'string') {
    return (w[0] as { error: string }).error;
  }
  return null;
}

/**
 * Local development without network: ids ending in 000 are "invalid", ending in 999 make
 * VIES "unavailable", everything else is valid.
 */
export const fakeVies: ViesChecker = async (vatId) => {
  if (vatId.endsWith('000')) return { status: 'invalid' };
  if (vatId.endsWith('999')) return { status: 'unavailable', error: 'MS_UNAVAILABLE' };
  return { status: 'valid', name: 'Testfirma (VIES-Ersatz)', address: null };
};

/** VIES_FAKE=1 (local development only) uses the stand-in. */
export function viesFromEnv(env: NodeJS.ProcessEnv = process.env): ViesChecker {
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(
    env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
  );
  return env.VIES_FAKE === '1' && local ? fakeVies : viesChecker();
}
