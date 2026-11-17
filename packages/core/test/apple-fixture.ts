// Test stand-ins for Apple: a certificate chain like Apple's (test root, intermediate and leaf
// with Apple's marker extensions, made with openssl and valid until 2126; fixtures/apple), JWS
// signed with it, and a fake App Store Server API.
import { createSign, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./fixtures/apple/', import.meta.url));
const read = (f: string) => readFileSync(`${dir}${f}`, 'utf8');
const der = (pem: string) => new X509Certificate(pem).raw.toString('base64');

const ROOT = read('root.pem');
const INTERMEDIATE = read('intermediate.pem');
const LEAF = read('leaf.pem');
const LEAF_PLAIN = read('leaf-plain.pem');
const LEAF_KEY = read('leaf-key.pem');

/** SHA-256 of the test root, to pass as `roots`. */
export const TEST_ROOT = new X509Certificate(ROOT).fingerprint256;

/** A JWS like the App Store's. `chain`: which certificates go into x5c. */
export function signApple(
  payload: Record<string, unknown>,
  opts: { chain?: 'apple' | 'no-marker' | 'two' } = {},
): string {
  const leaf = opts.chain === 'no-marker' ? LEAF_PLAIN : LEAF;
  const x5c =
    opts.chain === 'two'
      ? [der(leaf), der(INTERMEDIATE)]
      : [der(leaf), der(INTERMEDIATE), der(ROOT)];
  const header = { alg: 'ES256', x5c };
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(
    JSON.stringify(payload),
  ).toString('base64url')}`;
  const sig = createSign('SHA256').update(input).sign({ key: LEAF_KEY, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

export const BUNDLE = 'com.overpricedcardboard.app';

/** A transaction payload (JWSTransactionDecodedPayload) for a subscription. */
export function appleTx(o: {
  original: string;
  product: string;
  expires: Date;
  token?: string | null;
  environment?: 'Production' | 'Sandbox';
  transactionId?: string;
  offerType?: number;
  offerIdentifier?: string;
  revoked?: Date;
  bundleId?: string;
  type?: string;
}): Record<string, unknown> {
  return {
    transactionId: o.transactionId ?? `${o.original}9`,
    originalTransactionId: o.original,
    webOrderLineItemId: '1000000099999999',
    bundleId: o.bundleId ?? BUNDLE,
    productId: o.product,
    subscriptionGroupIdentifier: '21000001',
    purchaseDate: o.expires.getTime() - 30 * 86400_000,
    originalPurchaseDate: o.expires.getTime() - 30 * 86400_000,
    expiresDate: o.expires.getTime(),
    quantity: 1,
    type: o.type ?? 'Auto-Renewable Subscription',
    ...(o.token === null ? {} : { appAccountToken: o.token }),
    inAppOwnershipType: 'PURCHASED',
    signedDate: Date.now(),
    environment: o.environment ?? 'Production',
    transactionReason: 'PURCHASE',
    storefront: 'AUT',
    storefrontId: '143445',
    price: 7990,
    currency: 'EUR',
    ...(o.offerType ? { offerType: o.offerType } : {}),
    ...(o.offerIdentifier ? { offerIdentifier: o.offerIdentifier } : {}),
    ...(o.revoked ? { revocationDate: o.revoked.getTime(), revocationReason: 0 } : {}),
  };
}

export type FakeSub = {
  status: number;
  tx: Record<string, unknown>;
  autoRenew?: boolean;
  grace?: Date;
  environment?: 'Production' | 'Sandbox';
};

/** The App Store Server API as the test wants it: original transaction id → its status. */
export class FakeAppleApi {
  subs = new Map<string, FakeSub>();
  calls: { url: string; auth: string }[] = [];
  down = false;
  unauthorized = false;
  bundleId = BUNDLE;
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    this.calls.push({ url, auth });
    if (this.down) return new Response('busy', { status: 503 });
    if (this.unauthorized) return new Response('', { status: 401 });
    const m =
      /^https:\/\/api\.storekit(-sandbox)?\.itunes\.apple\.com\/inApps\/v1\/subscriptions\/(\d+)$/.exec(
        url,
      );
    if (!m) return new Response('{}', { status: 404 });
    const env = m[1] ? 'Sandbox' : 'Production';
    const sub = this.subs.get(m[2]!);
    if (!sub || (sub.environment ?? 'Production') !== env) {
      return Response.json(
        { errorCode: 4040010, errorMessage: 'Transaction id not found.' },
        { status: 404 },
      );
    }
    return Response.json({
      environment: env,
      bundleId: this.bundleId,
      appAppleId: 6700000000,
      data: [
        {
          subscriptionGroupIdentifier: '21000001',
          lastTransactions: [
            {
              originalTransactionId: m[2],
              status: sub.status,
              signedTransactionInfo: signApple(sub.tx),
              signedRenewalInfo: signApple({
                originalTransactionId: m[2],
                autoRenewProductId: sub.tx.productId,
                productId: sub.tx.productId,
                autoRenewStatus: sub.autoRenew === false ? 0 : 1,
                ...(sub.grace ? { gracePeriodExpiresDate: sub.grace.getTime() } : {}),
                signedDate: Date.now(),
                environment: env,
              }),
            },
          ],
        },
      ],
    });
  };
}

/** An in-app purchase key like the .p8 file from App Store Connect. */
export function testP8() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey,
  };
}
