import type { NextRequest } from 'next/server';
import { signInWithIdentity, verifyGoogleIdToken, type Identity } from '@pokeshop/core/app-signin';
import { config, db, googleSigningKeys } from '@/server/config';
import { apiError, deviceFields, jsonBody, signedIn, signInLimited } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/**
 * POST /api/app/v1/login/google – "Continue with Google": the app sends the ID token of the
 * phone's Google account; the account with that e-mail address signs in, or is created.
 */
export async function POST(req: NextRequest) {
  const limited = signInLimited(req);
  if (limited) return limited;
  const b = await jsonBody(req);
  const d = deviceFields(b);
  const fields = d.ok ? {} : { ...d.fields };
  const idToken = typeof b?.id_token === 'string' ? b.id_token.trim() : '';
  if (!idToken) fields.id_token = 'required';
  if (!b || !d.ok || Object.keys(fields).length) {
    return apiError(400, 'invalid_request', 'Check the request body.', { fields });
  }
  let identity: Identity;
  const test = /^test_google:(.+)$/.exec(idToken);
  if (test && config.storeTestHooks) {
    // staging: "test_google:<email>" stands for a Google account with that address
    const email = test[1]!.trim().toLowerCase();
    identity = { provider: 'google', subject: `test:${email}`, email, name: null };
  } else {
    if (config.googleClientIds.length === 0) {
      return apiError(503, 'not_configured', 'Sign-in with Google is not set up on this server.');
    }
    try {
      identity = await verifyGoogleIdToken(idToken, {
        audiences: config.googleClientIds,
        keys: googleSigningKeys(),
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'keys_unavailable') {
        return apiError(503, 'store_unavailable', 'Google did not answer. Try again.');
      }
      return apiError(400, 'invalid_identity', 'The Google sign-in is invalid or expired.');
    }
  }
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(identity.email ?? '')) {
    return apiError(400, 'invalid_identity', 'The Google account has no usable e-mail address.');
  }
  const r = await signInWithIdentity(db(), identity, d.device, { baseUrl: config.baseUrl });
  if (!r.ok) {
    if (r.problem === 'device_limit') {
      return apiError(409, 'device_limit', 'All devices of this subscription are in use.', {
        seats: r.seats,
      });
    }
    return apiError(400, 'invalid_identity', 'The Google account has no e-mail address.');
  }
  return signedIn(r, 200, b);
}
