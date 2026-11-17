import type { NextRequest } from 'next/server';
import { signInWithIdentity, verifyAppleIdToken, type Identity } from '@pokeshop/core/app-signin';
import { exchangeAppleCode } from '@pokeshop/core/apple';
import { encryptSecret } from '@pokeshop/core/secrets';
import { apiMasterKey, appleSignInKey, appleSigningKeys, config, db } from '@/server/config';
import { apiError, deviceFields, jsonBody, signedIn, signInLimited } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/**
 * POST /api/app/v1/login/apple – "Sign in with Apple": the app sends the identity token and the
 * authorization code; the account of that Apple ID (or with its e-mail address) signs in, or is
 * created. The code is exchanged for a refresh token, kept encrypted so that deleting the account
 * revokes it at Apple.
 */
export async function POST(req: NextRequest) {
  const limited = signInLimited(req);
  if (limited) return limited;
  const b = await jsonBody(req);
  const d = deviceFields(b);
  const fields = d.ok ? {} : { ...d.fields };
  const idToken = typeof b?.identity_token === 'string' ? b.identity_token.trim() : '';
  const code = typeof b?.authorization_code === 'string' ? b.authorization_code.trim() : '';
  if (!idToken) fields.identity_token = 'required';
  if (code.length > 1024) fields.authorization_code = 'invalid';
  if (!b || !d.ok || Object.keys(fields).length) {
    return apiError(400, 'invalid_request', 'Check the request body.', { fields });
  }
  let identity: Identity;
  let refreshToken: string | null = null;
  const test = /^test_apple:(.+)$/.exec(idToken);
  if (test && config.storeTestHooks) {
    // staging: "test_apple:<email>" stands for an Apple ID with that address
    const email = test[1]!.trim().toLowerCase();
    identity = { provider: 'apple', subject: `test:${email}`, email, name: null };
    if (code) refreshToken = `test_refresh:${code}`;
  } else {
    try {
      identity = await verifyAppleIdToken(idToken, {
        audiences: [config.appleBundleId],
        keys: appleSigningKeys(),
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'keys_unavailable') {
        return apiError(503, 'store_unavailable', 'Apple did not answer. Try again.');
      }
      return apiError(400, 'invalid_identity', 'The Apple sign-in is invalid or expired.');
    }
    const key = appleSignInKey();
    if (code && key) {
      try {
        refreshToken = await exchangeAppleCode(key, code, identity.subject);
      } catch (e) {
        // signing in works without it; only the revocation at deletion is missing then
        console.error('[apple] exchanging the authorization code failed:', (e as Error).message);
      }
    }
  }
  if (identity.email && !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(identity.email)) {
    return apiError(400, 'invalid_identity', 'The Apple ID has no usable e-mail address.');
  }
  let refreshTokenEnc: string | null = null;
  if (refreshToken) {
    try {
      refreshTokenEnc = encryptSecret(refreshToken, apiMasterKey());
    } catch (e) {
      console.error('[apple] keeping the refresh token failed:', (e as Error).message);
    }
  }
  const r = await signInWithIdentity(db(), identity, d.device, {
    baseUrl: config.baseUrl,
    refreshTokenEnc,
  });
  if (!r.ok) {
    if (r.problem === 'device_limit') {
      return apiError(409, 'device_limit', 'All devices of this subscription are in use.', {
        seats: r.seats,
      });
    }
    return apiError(
      400,
      'invalid_identity',
      'Apple did not share an e-mail address for this Apple ID. Use another e-mail to sign in.',
    );
  }
  return signedIn(r, 200, b);
}
