import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { decodeIdToken, generateCodeVerifier, generateState, MicrosoftEntraId } from 'arctic';
import { config, db } from './config';

export type AdminRole = 'owner' | 'staff';
export type AdminUser = { subject: string; email: string; name: string | null; role: AdminRole };

const SESSION_COOKIE = 'pk_admin';
const SESSION_HOURS = 12;

const secure = () => config.baseUrl.startsWith('https://');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Local development only: sign in without Microsoft. Allowed when
 * ADMIN_DEV_LOGIN=true and the shop runs on localhost – never on a real host.
 */
export function devLoginAllowed(): boolean {
  if (process.env.ADMIN_DEV_LOGIN !== 'true') return false;
  try {
    const host = new URL(config.baseUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

export function entraConfigured(): boolean {
  return Boolean(
    process.env.ENTRA_TENANT_ID && process.env.ENTRA_CLIENT_ID && process.env.ENTRA_CLIENT_SECRET,
  );
}

function entra(): MicrosoftEntraId {
  return new MicrosoftEntraId(
    process.env.ENTRA_TENANT_ID!,
    process.env.ENTRA_CLIENT_ID!,
    process.env.ENTRA_CLIENT_SECRET!,
    `${config.baseUrl}/admin/auth/callback`,
  );
}

export async function createSession(user: AdminUser): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  await db()`
    INSERT INTO admin_sessions (token_hash, subject, email, name, role, expires_at, ip, user_agent)
    VALUES (${hash(token)}, ${user.subject}, ${user.email}, ${user.name}, ${user.role},
            now() + make_interval(hours => ${SESSION_HOURS}),
            ${ip && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null}::inet, ${h.get('user-agent')?.slice(0, 300) ?? null})`;
  await db()`DELETE FROM admin_sessions WHERE expires_at < now()`;
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secure(),
    sameSite: 'lax',
    path: '/admin',
    maxAge: SESSION_HOURS * 3600,
  });
}

export async function currentAdmin(): Promise<AdminUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [s] = await db()<AdminUser[]>`
    UPDATE admin_sessions SET last_seen_at = now()
     WHERE token_hash = ${hash(token)} AND expires_at > now()
    RETURNING subject, email, name, role`;
  return s ?? null;
}

/** For admin pages and actions: the signed-in user, or a redirect to the sign-in page. */
export async function requireAdmin(role?: AdminRole): Promise<AdminUser> {
  const user = await currentAdmin();
  if (!user) redirect('/admin/login');
  if (role === 'owner' && user.role !== 'owner') redirect('/admin?denied=1');
  return user;
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db()`DELETE FROM admin_sessions WHERE token_hash = ${hash(token)}`;
  jar.delete({ name: SESSION_COOKIE, path: '/admin' });
}

/** Starts the Microsoft sign-in: PKCE verifier and state in short-lived cookies. */
export async function startEntraLogin(): Promise<URL> {
  const state = generateState();
  const verifier = generateCodeVerifier();
  const url = entra().createAuthorizationURL(state, verifier, ['openid', 'profile', 'email']);
  url.searchParams.set('prompt', 'select_account');
  const jar = await cookies();
  const opts = {
    httpOnly: true,
    secure: secure(),
    sameSite: 'lax' as const,
    path: '/admin/auth',
    maxAge: 600,
  };
  jar.set('pk_oauth_state', state, opts);
  jar.set('pk_oauth_verifier', verifier, opts);
  return url;
}

type IdClaims = {
  oid?: string;
  sub?: string;
  tid?: string;
  iss?: string;
  aud?: string;
  exp?: number;
  email?: string;
  preferred_username?: string;
  name?: string;
  groups?: string[];
  roles?: string[];
};

/** Who may use the admin: members of the owner/staff groups, or holders of the app roles. */
export function roleFromClaims(c: IdClaims): AdminRole | null {
  const groups = c.groups ?? [];
  const roles = c.roles ?? [];
  const owner = process.env.ENTRA_OWNER_GROUP_ID;
  const staff = process.env.ENTRA_STAFF_GROUP_ID;
  if ((owner && groups.includes(owner)) || roles.includes('Shop.Owner')) return 'owner';
  if ((staff && groups.includes(staff)) || roles.includes('Shop.Staff')) return 'staff';
  return null;
}

export type CallbackResult =
  { ok: true } | { ok: false; reason: 'state' | 'token' | 'tenant' | 'not_allowed' };

/** Finishes the Microsoft sign-in. The ID token comes straight from Microsoft's token endpoint over TLS. */
export async function finishEntraLogin(
  code: string | null,
  state: string | null,
): Promise<CallbackResult> {
  const jar = await cookies();
  const expected = jar.get('pk_oauth_state')?.value;
  const verifier = jar.get('pk_oauth_verifier')?.value;
  jar.delete({ name: 'pk_oauth_state', path: '/admin/auth' });
  jar.delete({ name: 'pk_oauth_verifier', path: '/admin/auth' });
  if (!code || !state || !expected || !verifier || state !== expected)
    return { ok: false, reason: 'state' };
  let claims: IdClaims;
  try {
    const tokens = await entra().validateAuthorizationCode(code, verifier);
    claims = decodeIdToken(tokens.idToken()) as IdClaims;
  } catch {
    return { ok: false, reason: 'token' };
  }
  const tenant = process.env.ENTRA_TENANT_ID!;
  if (
    claims.tid !== tenant ||
    claims.aud !== process.env.ENTRA_CLIENT_ID ||
    (claims.exp ?? 0) * 1000 < Date.now()
  ) {
    return { ok: false, reason: 'tenant' };
  }
  const role = roleFromClaims(claims);
  if (!role) return { ok: false, reason: 'not_allowed' };
  await createSession({
    subject: claims.oid ?? claims.sub ?? 'unknown',
    email: claims.email ?? claims.preferred_username ?? 'unknown',
    name: claims.name ?? null,
    role,
  });
  return { ok: true };
}

export async function audit(
  actor: AdminUser,
  action: string,
  entity: string,
  entityId: string | number,
  before: unknown,
  after: unknown,
) {
  await db()`
    INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
    VALUES (${actor.email}, ${action}, ${entity}, ${String(entityId)},
            ${before === null ? null : db().json(before as never)}, ${after === null ? null : db().json(after as never)})`;
}
