import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeErrorReason,
  describeEntraFailure,
  entraSettingsFromEnv,
  entraSettingsProblem,
  redeemEntraCode,
  sameTenant,
  type EntraSettings,
} from '../src/entra-login.ts';

const TENANT = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const CLIENT = '11111111-2222-3333-4444-555555555555';
const settings: EntraSettings = {
  tenantId: TENANT,
  clientId: CLIENT,
  clientSecret: 'abC8Q~exampleSecretValue.with-chars_0123456',
  redirectUri: 'https://staging.overpricedcardboard.com/admin/auth/callback',
};

test('settings are trimmed and checked for typical mix-ups', () => {
  const s = entraSettingsFromEnv(
    {
      ENTRA_TENANT_ID: ` ${TENANT} `,
      ENTRA_CLIENT_ID: CLIENT,
      ENTRA_CLIENT_SECRET: `${settings.clientSecret}\n`,
    },
    settings.redirectUri,
  );
  assert.deepEqual(s, settings);
  assert.equal(entraSettingsProblem(settings), null);
  assert.equal(entraSettingsFromEnv({ ENTRA_TENANT_ID: TENANT }, 'x'), null);
  assert.equal(
    entraSettingsProblem({ ...settings, tenantId: 'overpricedcardboard.com' }),
    'tenant_id',
  );
  assert.equal(
    entraSettingsProblem({ ...settings, clientId: 'overpricedcardboard-admin' }),
    'client_id',
  );
  // the "Secret ID" column of a client secret is a GUID
  assert.equal(
    entraSettingsProblem({ ...settings, clientSecret: '9a8b7c6d-5e4f-3a2b-1c0d-ffeeddccbbaa' }),
    'secret_id',
  );
});

test('the code is redeemed with the secret in the form body', async () => {
  let seen: { url: string; body: URLSearchParams; auth: string | null } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    seen = {
      url,
      body: init.body as URLSearchParams,
      auth: new Headers(init.headers).get('authorization'),
    };
    return Response.json({ id_token: 'header.payload.sig', token_type: 'Bearer' });
  }) as unknown as typeof fetch;
  const r = await redeemEntraCode(settings, 'the-code', 'the-verifier', ['openid', 'email'], fake);
  assert.deepEqual(r, { ok: true, idToken: 'header.payload.sig' });
  assert.equal(seen!.url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  assert.equal(seen!.auth, null);
  assert.equal(seen!.body.get('client_secret'), settings.clientSecret);
  assert.equal(seen!.body.get('client_id'), CLIENT);
  assert.equal(seen!.body.get('code_verifier'), 'the-verifier');
  assert.equal(seen!.body.get('redirect_uri'), settings.redirectUri);
  assert.equal(seen!.body.get('scope'), 'openid email');
});

test('a wrong secret is reported with its AADSTS code and a hint', async () => {
  const fake = (async () =>
    Response.json(
      {
        error: 'invalid_client',
        error_description:
          'AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID.\r\nTrace ID: abc\r\nCorrelation ID: def',
        error_codes: [7000215],
        trace_id: 'abc',
      },
      { status: 401 },
    )) as unknown as typeof fetch;
  const r = await redeemEntraCode(settings, 'c', 'v', ['openid'], fake);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, 'invalid_client');
  assert.deepEqual(r.codes, [7000215]);
  assert.ok(!r.description.includes('Trace ID'));
  assert.match(r.hint ?? '', /"Value"/);
  assert.match(
    describeEntraFailure(r),
    /^invalid_client: AADSTS7000215: Invalid client secret.*\(trace abc\) → /,
  );
});

test('a redirect URI registered as single-page app gets its own hint', async () => {
  const fake = (async () =>
    Response.json(
      {
        error: 'invalid_request',
        error_description:
          "AADSTS9002327: Tokens issued for the 'Single-Page Application' client-type may only be redeemed via cross-origin requests.",
      },
      { status: 400 },
    )) as unknown as typeof fetch;
  const r = await redeemEntraCode(settings, 'c', 'v', ['openid'], fake);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.codes, [9002327]);
    assert.match(r.hint ?? '', /platform "Web"|Platform "Web"/);
  }
});

test('an unreachable Microsoft is a network error, not a crash', async () => {
  const fake = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  const r = await redeemEntraCode(settings, 'c', 'v', ['openid'], fake);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error, 'network');
    assert.match(r.hint ?? '', /login\.microsoftonline\.com/);
  }
});

test('errors sent to the callback are sorted for the login page', () => {
  assert.equal(
    authorizeErrorReason(
      'access_denied',
      'AADSTS65004: User declined to consent to access the app.',
    ),
    'cancelled',
  );
  assert.equal(authorizeErrorReason('access_denied', null), 'cancelled');
  assert.equal(
    authorizeErrorReason(
      'access_denied',
      "AADSTS50105: Your administrator has configured the application to block users unless they are specifically granted ('assigned') access.",
    ),
    'not_assigned',
  );
  assert.equal(
    authorizeErrorReason('invalid_request', 'AADSTS50011: The redirect URI does not match.'),
    'denied',
  );
});

test('tenant and app ids compare without regard to case', () => {
  assert.equal(sameTenant(TENANT.toUpperCase(), TENANT), true);
  assert.equal(sameTenant(undefined, TENANT), false);
  assert.equal(sameTenant(CLIENT, TENANT), false);
});
