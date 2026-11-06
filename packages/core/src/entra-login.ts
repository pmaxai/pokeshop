/**
 * Admin sign-in with Microsoft Entra ID: settings checks, code redemption and readable errors.
 *
 * Microsoft answers a failed sign-in with an AADSTS code. The shop logs that code with a hint
 * on what to change, so a setup mistake can be found in the web container's log.
 */

export type EntraSettings = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the ENTRA_* variables, trimmed. Null while one of them is missing. */
export function entraSettingsFromEnv(
  env: NodeJS.ProcessEnv,
  redirectUri: string,
): EntraSettings | null {
  const tenantId = env.ENTRA_TENANT_ID?.trim();
  const clientId = env.ENTRA_CLIENT_ID?.trim();
  const clientSecret = env.ENTRA_CLIENT_SECRET?.trim();
  if (!tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret, redirectUri };
}

export type EntraSettingsProblem = 'tenant_id' | 'client_id' | 'secret_id';

/**
 * Setup mistakes Microsoft would only report vaguely. A client secret value is about
 * 40 characters with "~" in it; a GUID there is the secret's ID, not its value.
 */
export function entraSettingsProblem(s: EntraSettings): EntraSettingsProblem | null {
  if (!GUID.test(s.tenantId)) return 'tenant_id';
  if (!GUID.test(s.clientId)) return 'client_id';
  if (GUID.test(s.clientSecret)) return 'secret_id';
  return null;
}

/** What to change for the AADSTS codes a setup mistake typically causes. */
const HINTS: Record<number, string> = {
  7000215:
    'ENTRA_CLIENT_SECRET is not the secret value. Copy the "Value" column of the client secret ' +
    '(not the "Secret ID"); if the value is no longer shown, create a new client secret.',
  7000222: 'The client secret has expired. Create a new one under Certificates & secrets.',
  9002327:
    'The redirect URI is registered as a "Single-page application". Remove it there and add it ' +
    'under Authentication → Platform "Web".',
  700025:
    'The app is treated as a public client. Register the redirect URI under the platform "Web" ' +
    'and set "Allow public client flows" to No.',
  50011: 'The redirect URI is not registered. Add it under Authentication → Platform "Web".',
  700016:
    'ENTRA_CLIENT_ID is not an app in this tenant. Check ENTRA_CLIENT_ID and ENTRA_TENANT_ID.',
  90002: 'ENTRA_TENANT_ID was not found. Use the "Directory (tenant) ID" of the app registration.',
  50105:
    'The account is not assigned to the app. Enterprise applications → pokemonkarten-admin → ' +
    'Users and groups → add the user with a role.',
  65001: 'Consent is missing. API permissions → "Grant admin consent".',
  54005: 'The sign-in code was used twice (e.g. the callback page was reloaded). Sign in again.',
  70008: 'The sign-in code expired. Sign in again.',
  501481: 'PKCE check failed. Sign in again; if it repeats, delete the cookies of the site.',
};

export function entraHint(codes: readonly number[]): string | null {
  for (const c of codes) if (HINTS[c]) return HINTS[c];
  return null;
}

/** AADSTS numbers named in an error description ("AADSTS7000215: Invalid client secret …"). */
export function aadstsCodes(text: string | null | undefined): number[] {
  return [...(text ?? '').matchAll(/AADSTS(\d{4,7})/g)].map((m) => Number(m[1]));
}

export type EntraFailure = {
  ok: false;
  /** OAuth error, e.g. "invalid_client", or "network" when Microsoft could not be reached. */
  error: string;
  codes: number[];
  /** First line of Microsoft's description (no trace lines). */
  description: string;
  traceId: string | null;
  hint: string | null;
};

export type TokenResult = { ok: true; idToken: string } | EntraFailure;

/**
 * Redeems the authorization code at Microsoft's token endpoint. The client secret goes in the
 * form body (client_secret_post), the way Microsoft documents the authorization code flow.
 */
export async function redeemEntraCode(
  s: EntraSettings,
  code: string,
  codeVerifier: string,
  scopes: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: s.clientId,
    client_secret: s.clientSecret,
    code,
    redirect_uri: s.redirectUri,
    code_verifier: codeVerifier,
    scope: scopes.join(' '),
  });
  let res: Response;
  try {
    res = await fetchImpl(
      `https://login.microsoftonline.com/${encodeURIComponent(s.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (e) {
    return {
      ok: false,
      error: 'network',
      codes: [],
      description: (e as Error).message,
      traceId: null,
      hint: 'The server cannot reach login.microsoftonline.com (DNS, firewall or proxy).',
    };
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // not JSON: reported below with the HTTP status
  }
  if (res.ok && typeof data.id_token === 'string') return { ok: true, idToken: data.id_token };

  const description =
    typeof data.error_description === 'string'
      ? (data.error_description.split(/\r?\n/)[0] ?? '')
      : `HTTP ${res.status}`;
  const listed = Array.isArray(data.error_codes)
    ? data.error_codes.filter((n): n is number => typeof n === 'number')
    : [];
  const codes = listed.length ? listed : aadstsCodes(description);
  return {
    ok: false,
    error:
      typeof data.error === 'string' ? data.error : res.ok ? 'no_id_token' : `http_${res.status}`,
    codes,
    description,
    traceId: typeof data.trace_id === 'string' ? data.trace_id : null,
    hint:
      entraHint(codes) ??
      (res.ok ? 'The token response has no ID token; is "openid" among the scopes?' : null),
  };
}

/** One log line for a failed sign-in, with the hint when one is known. */
export function describeEntraFailure(f: Omit<EntraFailure, 'ok'>): string {
  // Microsoft's descriptions usually start with the code already ("AADSTS7000215: …").
  const code =
    f.codes.length && !f.description.includes(`AADSTS${f.codes[0]}`) ? ` AADSTS${f.codes[0]}` : '';
  const trace = f.traceId ? ` (trace ${f.traceId})` : '';
  return `${f.error}${code}: ${f.description}${trace}${f.hint ? ` → ${f.hint}` : ''}`;
}

/** Error sent back to the redirect URI (?error=…&error_description=…): what the login page shows. */
export function authorizeErrorReason(
  error: string,
  description: string | null,
): 'cancelled' | 'not_assigned' | 'denied' {
  const codes = aadstsCodes(description);
  if (codes.includes(50105)) return 'not_assigned';
  if (codes.includes(65004) || (error === 'access_denied' && codes.length === 0))
    return 'cancelled';
  return 'denied';
}

/** Tenant ids are GUIDs; compare without regard to case. */
export function sameTenant(claimed: string | undefined, configured: string): boolean {
  return Boolean(claimed) && claimed!.toLowerCase() === configured.toLowerCase();
}
