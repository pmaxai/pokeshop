// Apple, for the iPhone app: checking what Apple signs (StoreKit 2 transactions, App Store
// Server Notifications V2, the App Store Server API's answers) against Apple's certificate chain,
// the App Store Server API client, and Sign in with Apple (the authorization code exchanged for a
// refresh token, which is revoked when the account is deleted). No database here; the purchases
// are stored by store-apple.ts. See docs/app-account-api.md and docs/deploy.md.
import { X509Certificate } from 'node:crypto';
import { decodeJwt, JwtError, signEs256, verifySignature } from './jwt.ts';
import { PurchaseInvalid, StoreUnavailable, type StoreState } from './store.ts';

/**
 * SHA-256 of Apple Root CA - G3, the root of every App Store signature
 * (https://www.apple.com/certificateauthority/, fingerprint as published by Apple).
 */
export const APPLE_ROOT_CA_G3_SHA256 =
  '63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179';

// The marker extensions Apple's verification libraries check: the leaf (Mac App Store and
// iTunes Store receipt signing, 1.2.840.113635.100.6.11.1) and the intermediate (Apple Worldwide
// Developer Relations, 1.2.840.113635.100.6.2.1), as DER-encoded object identifiers.
const LEAF_OID = Buffer.from('060a2a864886f76364060b01', 'hex');
const INTERMEDIATE_OID = Buffer.from('060a2a864886f76364060201', 'hex');

/** The App Store's notifications hold two signed tokens with three certificates each. */
const MAX_JWS = 64_000;

const hex = (s: string) => s.replace(/[^0-9a-f]/gi, '').toUpperCase();

/**
 * Checks a JWS signed by the App Store: three certificates up to Apple Root CA - G3 (or a root
 * given for tests), each valid when it was signed, Apple's markers on the leaf and the
 * intermediate, and the ES256 signature with the leaf's key. Returns the payload.
 */
export function verifyAppleJws(
  token: string,
  opts: { roots?: string[]; now?: Date } = {},
): Record<string, unknown> {
  const parts = decodeJwt(token, MAX_JWS);
  if (parts.header.alg !== 'ES256') throw new JwtError('algorithm');
  const x5c = parts.header.x5c;
  if (!Array.isArray(x5c) || x5c.length !== 3 || !x5c.every((c) => typeof c === 'string')) {
    throw new JwtError('certificate_chain');
  }
  let certs: X509Certificate[];
  try {
    certs = x5c.map((c) => new X509Certificate(Buffer.from(c, 'base64')));
  } catch {
    throw new JwtError('certificate_chain');
  }
  const [leaf, intermediate, root] = certs as [X509Certificate, X509Certificate, X509Certificate];
  const pinned = (opts.roots ?? [APPLE_ROOT_CA_G3_SHA256]).map(hex);
  if (!pinned.includes(hex(root.fingerprint256))) throw new JwtError('untrusted_root');
  // the certificates had to be valid when Apple signed (signedDate), as Apple's libraries check
  const signed = parts.payload.signedDate;
  const at = (opts.now ?? (typeof signed === 'number' ? new Date(signed) : new Date())).getTime();
  for (const c of certs) {
    if (Date.parse(c.validFrom) > at || Date.parse(c.validTo) < at) {
      throw new JwtError('certificate_expired');
    }
  }
  if (
    !intermediate.ca ||
    !intermediate.checkIssued(root) ||
    !intermediate.verify(root.publicKey) ||
    !leaf.checkIssued(intermediate) ||
    !leaf.verify(intermediate.publicKey) ||
    !leaf.raw.includes(LEAF_OID) ||
    !intermediate.raw.includes(INTERMEDIATE_OID)
  ) {
    throw new JwtError('certificate_chain');
  }
  if (!verifySignature(parts, leaf.publicKey)) throw new JwtError('signature');
  return parts.payload;
}

// ---------------------------------------------------------------------------
// Transactions and renewal info
// ---------------------------------------------------------------------------

export type AppleEnvironment = 'Production' | 'Sandbox';

/** JWSTransactionDecodedPayload, reduced to what the shop uses. */
export type AppleTransaction = {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  type: string;
  expiresAt: Date | null;
  /** the account's store_ref, when the app passed it (not through Apple's offer-code sheet) */
  appAccountToken: string | null;
  environment: AppleEnvironment;
  /** 1 introductory, 2 promotional, 3 offer code, 4 win-back */
  offerType: number | null;
  offerIdentifier: string | null;
  /** ISO 3166-1 alpha-2, from the storefront */
  country: string | null;
  revokedAt: Date | null;
  raw: Record<string, unknown>;
};

/** JWSRenewalInfoDecodedPayload, reduced. */
export type AppleRenewal = {
  autoRenew: boolean;
  autoRenewProductId: string | null;
  gracePeriodEndsAt: Date | null;
  raw: Record<string, unknown>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? new Date(v) : null);

export function parseAppleTransaction(p: Record<string, unknown>): AppleTransaction {
  const id = str(p.transactionId);
  const original = str(p.originalTransactionId);
  const productId = str(p.productId);
  if (!id || !original || !productId || !/^\d{1,40}$/.test(original)) {
    throw new PurchaseInvalid('not a transaction');
  }
  const token = str(p.appAccountToken) ?? '';
  const offer = Number(p.offerType);
  return {
    transactionId: id,
    originalTransactionId: original,
    bundleId: str(p.bundleId) ?? '',
    productId,
    type: str(p.type) ?? '',
    expiresAt: ms(p.expiresDate),
    appAccountToken: UUID.test(token) ? token.toLowerCase() : null,
    environment:
      p.environment === 'Sandbox' || p.environment === 'Xcode' ? 'Sandbox' : 'Production',
    offerType: Number.isInteger(offer) && offer > 0 ? offer : null,
    offerIdentifier: str(p.offerIdentifier)?.slice(0, 150) ?? null,
    country: alpha2(str(p.storefront)),
    revokedAt: ms(p.revocationDate),
    raw: p,
  };
}

export function parseAppleRenewal(p: Record<string, unknown>): AppleRenewal {
  return {
    autoRenew: p.autoRenewStatus === 1,
    autoRenewProductId: str(p.autoRenewProductId),
    gracePeriodEndsAt: ms(p.gracePeriodExpiresDate),
    raw: p,
  };
}

/** A subscription as the App Store reports it, reduced to what the shop uses. */
export type AppleSubscription = {
  originalTransactionId: string;
  state: StoreState;
  /** the product that runs now (a downgrade waits for the renewal: renewal's product) */
  productId: string;
  expiresAt: Date | null;
  autoRenew: boolean;
  storeRef: string | null;
  /** sandbox (TestFlight, App Review, sandbox testers) */
  test: boolean;
  latestOrderId: string | null;
  offerType: number | null;
  offerIdentifier: string | null;
  country: string | null;
  raw: Record<string, unknown>;
};

/**
 * The App Store's status of a subscription (1 active, 2 expired, 3 billing retry, 4 billing
 * grace period, 5 revoked) with its latest transaction and renewal info → AppleSubscription.
 */
export function appleSubscriptionOf(
  status: number,
  tx: AppleTransaction,
  renewal: AppleRenewal | null,
): AppleSubscription {
  const autoRenew = renewal?.autoRenew ?? false;
  const state: StoreState = tx.revokedAt
    ? 'revoked'
    : status === 1
      ? autoRenew
        ? 'active'
        : 'canceled'
      : status === 3
        ? 'on_hold'
        : status === 4
          ? 'grace'
          : status === 5
            ? 'revoked'
            : 'expired';
  return {
    originalTransactionId: tx.originalTransactionId,
    state,
    productId: tx.productId,
    expiresAt: state === 'grace' ? (renewal?.gracePeriodEndsAt ?? tx.expiresAt) : tx.expiresAt,
    autoRenew: autoRenew && state !== 'revoked' && state !== 'expired',
    storeRef: tx.appAccountToken,
    test: tx.environment === 'Sandbox',
    latestOrderId: tx.transactionId.slice(0, 100),
    offerType: tx.offerType,
    offerIdentifier: tx.offerIdentifier,
    country: tx.country,
    raw: { status, transaction: tx.raw, renewal: renewal?.raw ?? null },
  };
}

// ---------------------------------------------------------------------------
// App Store Server API
// ---------------------------------------------------------------------------

export interface AppStore {
  /** the app's bundle id; transactions of other apps are refused */
  readonly bundleId: string;
  /** The subscription of this original transaction as the App Store says now. */
  getSubscription(
    originalTransactionId: string,
    opts: { sandbox: boolean },
  ): Promise<AppleSubscription>;
  /** Checks a JWS signed by the App Store (transactions, notifications). */
  verify(jws: string): Record<string, unknown>;
}

export type AppStoreKey = {
  bundleId: string;
  issuerId: string;
  keyId: string;
  /** the .p8 file's contents */
  privateKey: string;
};

const SERVER = {
  Production: 'https://api.storekit.itunes.apple.com',
  Sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
} as const;

/** The App Store Server API with an in-app purchase key from App Store Connect. */
export function appStoreClient(
  opts: AppStoreKey & { fetch?: typeof fetch; roots?: string[] },
): AppStore {
  const f = opts.fetch ?? fetch;
  let token: { value: string; until: number } | null = null;
  const bearer = () => {
    if (token && token.until > Date.now() + 60_000) return token.value;
    const now = Math.floor(Date.now() / 1000);
    const value = signEs256(
      {
        iss: opts.issuerId,
        iat: now,
        exp: now + 1800,
        aud: 'appstoreconnect-v1',
        bid: opts.bundleId,
      },
      opts.privateKey,
      opts.keyId,
    );
    token = { value, until: (now + 1800) * 1000 };
    return value;
  };
  const verify = (jws: string) => verifyAppleJws(jws, { roots: opts.roots });
  /** null: the environment doesn't know the transaction */
  const statuses = async (env: AppleEnvironment, id: string) => {
    let r: Response;
    try {
      r = await f(`${SERVER[env]}/inApps/v1/subscriptions/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${bearer()}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new StoreUnavailable(`App Store: ${(e as Error).message}`);
    }
    if (r.status === 429 || r.status >= 500)
      throw new StoreUnavailable(`App Store: HTTP ${r.status}`);
    if (r.status === 401 || r.status === 403) {
      token = null;
      throw new StoreUnavailable(`App Store: HTTP ${r.status} (in-app purchase key?)`);
    }
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status === 404) return null;
    if (!r.ok)
      throw new PurchaseInvalid(`App Store: HTTP ${r.status} ${String(body.errorCode ?? '')}`);
    return body;
  };
  return {
    bundleId: opts.bundleId,
    verify,
    async getSubscription(id, { sandbox }) {
      if (!/^\d{1,40}$/.test(id)) throw new PurchaseInvalid('not a transaction id');
      const first: AppleEnvironment = sandbox ? 'Sandbox' : 'Production';
      const second: AppleEnvironment = sandbox ? 'Production' : 'Sandbox';
      const body = (await statuses(first, id)) ?? (await statuses(second, id));
      if (!body) throw new PurchaseInvalid('the App Store does not know this transaction');
      if (body.bundleId !== opts.bundleId) throw new PurchaseInvalid('another app');
      type Last = {
        originalTransactionId?: string;
        status?: number;
        signedTransactionInfo?: string;
        signedRenewalInfo?: string;
      };
      const groups = (Array.isArray(body.data) ? body.data : []) as { lastTransactions?: Last[] }[];
      const last = groups
        .flatMap((g) => (Array.isArray(g.lastTransactions) ? g.lastTransactions : []))
        .find((t) => t.originalTransactionId === id);
      if (!last?.signedTransactionInfo) throw new PurchaseInvalid('no such subscription');
      const tx = parseAppleTransaction(verify(last.signedTransactionInfo));
      if (tx.bundleId !== opts.bundleId) throw new PurchaseInvalid('another app');
      const renewal = last.signedRenewalInfo
        ? parseAppleRenewal(verify(last.signedRenewalInfo))
        : null;
      return appleSubscriptionOf(Number(last.status), tx, renewal);
    },
  };
}

/** The App Store Server API's key (APPLE_IAP_*), or null while it isn't set up. */
export function appStoreKeyFromEnv(env: NodeJS.ProcessEnv): AppStoreKey | null {
  const issuerId = env.APPLE_IAP_ISSUER_ID?.trim();
  const keyId = env.APPLE_IAP_KEY_ID?.trim();
  const privateKey = pem(env.APPLE_IAP_PRIVATE_KEY);
  if (!issuerId || !keyId || !privateKey) return null;
  return { bundleId: appleBundleId(env), issuerId, keyId, privateKey };
}

/** The iPhone app's bundle id (APPLE_BUNDLE_ID). */
export const appleBundleId = (env: NodeJS.ProcessEnv = process.env) =>
  env.APPLE_BUNDLE_ID?.trim() || 'com.overpricedcardboard.app';

/** A .p8 key as is, with "\n" for line breaks, or base64. */
function pem(v: string | undefined): string | null {
  const s = v?.trim();
  if (!s) return null;
  if (s.includes('-----BEGIN')) return s.replace(/\\n/g, '\n');
  const decoded = Buffer.from(s, 'base64').toString('utf8');
  return decoded.includes('-----BEGIN') ? decoded : null;
}

// ---------------------------------------------------------------------------
// App Store Server Notifications V2
// ---------------------------------------------------------------------------

export type AppleNotification = {
  type: string;
  subtype: string | null;
  uuid: string | null;
  bundleId: string | null;
  environment: AppleEnvironment;
  /** the transaction it is about (checked), if it carries one */
  transaction: AppleTransaction | null;
};

/** The body { signedPayload } → the checked notification; throws JwtError when it isn't Apple's. */
export function parseAppleNotification(
  body: unknown,
  verify: (jws: string) => Record<string, unknown>,
): AppleNotification | null {
  const signed = (body as { signedPayload?: unknown } | null)?.signedPayload;
  if (typeof signed !== 'string') return null;
  const n = verify(signed);
  const data = (n.data ?? {}) as Record<string, unknown>;
  const info = str(data.signedTransactionInfo);
  return {
    type: str(n.notificationType) ?? '',
    subtype: str(n.subtype),
    uuid: str(n.notificationUUID),
    bundleId: str(data.bundleId),
    environment: data.environment === 'Sandbox' ? 'Sandbox' : 'Production',
    transaction: info ? parseAppleTransaction(verify(info)) : null,
  };
}

// ---------------------------------------------------------------------------
// Sign in with Apple: code exchange and revocation
// ---------------------------------------------------------------------------

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';

export type AppleSignInKey = {
  teamId: string;
  keyId: string;
  privateKey: string;
  /** the app's bundle id: the client id of tokens from the app */
  clientId: string;
};

/** The Sign in with Apple key (APPLE_TEAM_ID, APPLE_SIGNIN_*), or null while it isn't set up. */
export function appleSignInKeyFromEnv(env: NodeJS.ProcessEnv): AppleSignInKey | null {
  const teamId = env.APPLE_TEAM_ID?.trim();
  const keyId = env.APPLE_SIGNIN_KEY_ID?.trim();
  const privateKey = pem(env.APPLE_SIGNIN_PRIVATE_KEY);
  if (!teamId || !keyId || !privateKey) return null;
  return { teamId, keyId, privateKey, clientId: appleBundleId(env) };
}

/** Apple's client secret: an ES256 token of the team, short-lived. */
export function appleClientSecret(key: AppleSignInKey, now = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  return signEs256(
    { iss: key.teamId, iat, exp: iat + 600, aud: APPLE_ISSUER, sub: key.clientId },
    key.privateKey,
    key.keyId,
  );
}

/** Apple refused the code or token (used, expired, for another app). */
export class AppleRefused extends Error {}

async function appleForm(
  url: string,
  form: Record<string, string>,
  f: typeof fetch,
): Promise<Record<string, unknown>> {
  let r: Response;
  try {
    r = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new StoreUnavailable(`Apple: ${(e as Error).message}`);
  }
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Apple's revoke answers with an empty body
  }
  if (r.status === 429 || r.status >= 500) throw new StoreUnavailable(`Apple: HTTP ${r.status}`);
  if (r.status === 400 && body.error === 'invalid_client') {
    throw new StoreUnavailable('Apple: invalid_client (Sign in with Apple key?)');
  }
  if (!r.ok) throw new AppleRefused(String(body.error ?? `HTTP ${r.status}`));
  return body;
}

/**
 * The authorization code from the app → the refresh token, kept to revoke at deletion. The code
 * is valid for 5 minutes, once. `subject`: the Apple user the sign-in was for; a token of
 * another user is not kept.
 */
export async function exchangeAppleCode(
  key: AppleSignInKey,
  code: string,
  subject: string,
  f: typeof fetch = fetch,
): Promise<string | null> {
  const body = await appleForm(
    `${APPLE_ISSUER}/auth/token`,
    {
      client_id: key.clientId,
      client_secret: appleClientSecret(key),
      code,
      grant_type: 'authorization_code',
    },
    f,
  );
  const refresh = str(body.refresh_token);
  const idToken = str(body.id_token);
  if (!refresh) return null;
  if (idToken) {
    try {
      if (decodeJwt(idToken).payload.sub !== subject) return null;
    } catch {
      return null;
    }
  }
  return refresh;
}

/** Revokes a refresh token at Apple; Apple then forgets that the user signed in to the app. */
export async function revokeAppleToken(
  key: AppleSignInKey,
  refreshToken: string,
  f: typeof fetch = fetch,
): Promise<void> {
  try {
    await appleForm(
      `${APPLE_ISSUER}/auth/revoke`,
      {
        client_id: key.clientId,
        client_secret: appleClientSecret(key),
        token: refreshToken,
        token_type_hint: 'refresh_token',
      },
      f,
    );
  } catch (e) {
    // an invalid token is no longer valid anyway
    if (e instanceof AppleRefused && /invalid_grant|invalid_request/.test(e.message)) return;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Storefronts: Apple names the country with three letters
// ---------------------------------------------------------------------------

const ALPHA3 = `AFG AF ALA AX ALB AL DZA DZ ASM AS AND AD AGO AO AIA AI ATA AQ ATG AG ARG AR ARM AM
ABW AW AUS AU AUT AT AZE AZ BHS BS BHR BH BGD BD BRB BB BLR BY BEL BE BLZ BZ BEN BJ BMU BM BTN BT
BOL BO BES BQ BIH BA BWA BW BVT BV BRA BR IOT IO BRN BN BGR BG BFA BF BDI BI CPV CV KHM KH CMR CM
CAN CA CYM KY CAF CF TCD TD CHL CL CHN CN CXR CX CCK CC COL CO COM KM COG CG COD CD COK CK CRI CR
CIV CI HRV HR CUB CU CUW CW CYP CY CZE CZ DNK DK DJI DJ DMA DM DOM DO ECU EC EGY EG SLV SV GNQ GQ
ERI ER EST EE SWZ SZ ETH ET FLK FK FRO FO FJI FJ FIN FI FRA FR GUF GF PYF PF ATF TF GAB GA GMB GM
GEO GE DEU DE GHA GH GIB GI GRC GR GRL GL GRD GD GLP GP GUM GU GTM GT GGY GG GIN GN GNB GW GUY GY
HTI HT HMD HM VAT VA HND HN HKG HK HUN HU ISL IS IND IN IDN ID IRN IR IRQ IQ IRL IE IMN IM ISR IL
ITA IT JAM JM JPN JP JEY JE JOR JO KAZ KZ KEN KE KIR KI PRK KP KOR KR KWT KW KGZ KG LAO LA LVA LV
LBN LB LSO LS LBR LR LBY LY LIE LI LTU LT LUX LU MAC MO MDG MG MWI MW MYS MY MDV MV MLI ML MLT MT
MHL MH MTQ MQ MRT MR MUS MU MYT YT MEX MX FSM FM MDA MD MCO MC MNG MN MNE ME MSR MS MAR MA MOZ MZ
MMR MM NAM NA NRU NR NPL NP NLD NL NCL NC NZL NZ NIC NI NER NE NGA NG NIU NU NFK NF MKD MK MNP MP
NOR NO OMN OM PAK PK PLW PW PSE PS PAN PA PNG PG PRY PY PER PE PHL PH PCN PN POL PL PRT PT PRI PR
QAT QA REU RE ROU RO RUS RU RWA RW BLM BL SHN SH KNA KN LCA LC MAF MF SPM PM VCT VC WSM WS SMR SM
STP ST SAU SA SEN SN SRB RS SYC SC SLE SL SGP SG SXM SX SVK SK SVN SI SLB SB SOM SO ZAF ZA SGS GS
SSD SS ESP ES LKA LK SDN SD SUR SR SJM SJ SWE SE CHE CH SYR SY TWN TW TJK TJ TZA TZ THA TH TLS TL
TGO TG TKL TK TON TO TTO TT TUN TN TUR TR TKM TM TCA TC TUV TV UGA UG UKR UA ARE AE GBR GB USA US
UMI UM URY UY UZB UZ VUT VU VEN VE VNM VN VGB VG VIR VI WLF WF ESH EH YEM YE ZMB ZM ZWE ZW XKS XK`;
let alpha3: Map<string, string> | undefined;

/** "AUT" → "AT"; null when unknown. */
export function alpha2(storefront: string | null | undefined): string | null {
  if (!storefront) return null;
  if (!alpha3) {
    const w = ALPHA3.split(/\s+/);
    alpha3 = new Map(Array.from({ length: w.length / 2 }, (_, i) => [w[2 * i]!, w[2 * i + 1]!]));
  }
  return alpha3.get(storefront.toUpperCase()) ?? null;
}
