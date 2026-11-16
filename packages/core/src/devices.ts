// Devices paired to an account. The portal shows a QR code (a URL with a one-time code, 10
// minutes); the app scans it and gets a device token. A device can also hand its slot to a new
// phone with a transfer code. Each subscription allows 1 + extra devices at the same time.
// See docs/app-account-api.md.
import { randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import { accountById, newPublicId, newToken, tokenHash, type Account } from './accounts.ts';
import type { Db, Sql } from './db.ts';
import { storeManageUrl } from './store.ts';
import {
  accountEntitlements,
  entitlements,
  accountServices,
  subscriptionOf,
  type Subscription,
  type Entitlements,
} from './subscriptions.ts';

export const PAIRING_MINUTES = 10;
/** Crockford base32 without I, L, O, U. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function newCode(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export const formatCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;

/**
 * The 12 characters of a pairing code from what was scanned or typed: a pair URL or the code,
 * with or without dashes and spaces, any case; O counts as 0, I and L as 1.
 */
export function normalizeCode(input: string): string | null {
  const fromUrl = /\/pair\/([0-9A-Za-z-\s]{12,20})\s*$/.exec(input.trim());
  const raw = (fromUrl ? fromUrl[1]! : input).toUpperCase().replace(/[\s-]/g, '');
  const c = raw.replace(/O/g, '0').replace(/[IL]/g, '1');
  return c.length === 12 && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? c : null;
}

export const pairUrl = (baseUrl: string, code: string) => `${baseUrl}/pair/${formatCode(code)}`;

/** The pair URL as an SVG QR code (error correction M, as the app's scanner expects). */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
    color: { dark: '#161c33', light: '#ffffff' },
  });
}

export type Device = {
  id: number;
  publicId: string;
  accountId: number;
  name: string | null;
  platform: string;
  appVersion: string | null;
  pairedAt: Date;
  lastSeenAt: Date | null;
};

type DeviceRow = {
  id: number;
  public_id: string;
  account_id: number;
  name: string | null;
  platform: string;
  app_version: string | null;
  paired_at: Date;
  last_seen_at: Date | null;
  ended_at: Date | null;
  end_reason: EndReason | null;
  successor_name: string | null;
};

export type EndReason = 'removed' | 'transferred' | 'replaced' | 'disconnected' | 'account_deleted';

const toDevice = (r: DeviceRow): Device => ({
  id: Number(r.id),
  publicId: r.public_id,
  accountId: Number(r.account_id),
  name: r.name,
  platform: r.platform,
  appVersion: r.app_version,
  pairedAt: r.paired_at,
  lastSeenAt: r.last_seen_at,
});

export async function listDevices(db: Db, accountId: number): Promise<Device[]> {
  const rows = await db<DeviceRow[]>`
    SELECT * FROM devices WHERE account_id = ${accountId} AND ended_at IS NULL ORDER BY paired_at`;
  return rows.map(toDevice);
}

/** A code for the portal's "Connect a device": only with a free slot. */
export async function createPairingCode(
  sql: Sql,
  account: Account,
  now = new Date(),
): Promise<
  | { ok: true; code: string; expiresAt: Date }
  | { ok: false; problem: 'subscription_required' | 'device_limit'; seats: number }
> {
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM accounts WHERE id = ${account.id} FOR UPDATE`;
    const ent = await accountEntitlements(tx, account, now);
    if (!ent.active) return { ok: false, problem: 'subscription_required', seats: 0 };
    const devices = await listDevices(tx, account.id);
    if (devices.length >= ent.seats)
      return { ok: false, problem: 'device_limit', seats: ent.seats };
    const code = newCode();
    const expiresAt = new Date(now.getTime() + PAIRING_MINUTES * 60_000);
    await tx`
      INSERT INTO pairing_codes (code_hash, account_id, created_at, expires_at)
      VALUES (${tokenHash(code)}, ${account.id}, ${now}, ${expiresAt})`;
    return { ok: true, code, expiresAt };
  });
}

/** A transfer code: the device hands its slot to the phone that scans it. */
export async function createTransferCode(
  db: Db,
  device: Device,
  now = new Date(),
): Promise<{ code: string; expiresAt: Date }> {
  const code = newCode();
  const expiresAt = new Date(now.getTime() + PAIRING_MINUTES * 60_000);
  await db`
    INSERT INTO pairing_codes (code_hash, account_id, from_device_id, created_at, expires_at)
    VALUES (${tokenHash(code)}, ${device.accountId}, ${device.id}, ${now}, ${expiresAt})`;
  return { code, expiresAt };
}

export type PairProblem =
  'invalid_code' | 'unknown_code' | 'code_expired' | 'device_limit' | 'subscription_required';

export type PairInput = {
  code: string;
  deviceUuid: string;
  name?: string | null;
  platform?: string;
  appVersion?: string | null;
  now?: Date;
};

/** Pairs a device with a code. The token is returned once; only its hash is kept. */
export async function pairDevice(
  sql: Sql,
  input: PairInput,
): Promise<
  | { ok: true; token: string; device: Device; account: Account }
  | { ok: false; problem: PairProblem; seats?: number }
> {
  const now = input.now ?? new Date();
  const code = normalizeCode(input.code);
  if (!code) return { ok: false, problem: 'invalid_code' };
  return sql.begin(async (tx) => {
    const [pc] = await tx<
      {
        account_id: number;
        from_device_id: number | null;
        expires_at: Date;
        used_at: Date | null;
      }[]
    >`SELECT account_id, from_device_id, expires_at, used_at FROM pairing_codes
       WHERE code_hash = ${tokenHash(code)} FOR UPDATE`;
    if (!pc) return { ok: false, problem: 'unknown_code' };
    if (pc.used_at || pc.expires_at <= now) return { ok: false, problem: 'code_expired' };
    const accountId = Number(pc.account_id);
    await tx`SELECT id FROM accounts WHERE id = ${accountId} FOR UPDATE`;
    const account = await accountById(tx, accountId);
    if (!account) return { ok: false, problem: 'unknown_code' };
    const name = input.name?.trim().slice(0, 80) || null;
    const appVersion = input.appVersion?.trim().slice(0, 40) || null;

    // a transfer: the old device must still hold its slot
    let from: DeviceRow | undefined;
    if (pc.from_device_id) {
      [from] = await tx<
        DeviceRow[]
      >`SELECT * FROM devices WHERE id = ${pc.from_device_id} FOR UPDATE`;
      if (!from || from.ended_at) return { ok: false, problem: 'code_expired' };
    } else {
      const ent = await accountEntitlements(tx, account, now);
      if (!ent.active) return { ok: false, problem: 'subscription_required' };
      const [n] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM devices
         WHERE account_id = ${accountId} AND ended_at IS NULL AND device_uuid <> ${input.deviceUuid}`;
      if ((n?.n ?? 0) >= ent.seats) return { ok: false, problem: 'device_limit', seats: ent.seats };
    }

    if (from && !from.ended_at) {
      await tx`
        UPDATE devices SET ended_at = ${now}, end_reason = 'transferred', successor_name = ${name}
         WHERE id = ${from.id} AND ended_at IS NULL`;
    }
    const { token, row: d } = await insertDevice(
      tx,
      accountId,
      { ...input, name, appVersion },
      now,
    );
    await tx`
      UPDATE pairing_codes SET used_at = ${now}, used_by = ${d.id} WHERE code_hash = ${tokenHash(code)}`;
    return { ok: true, token, device: toDevice(d), account };
  });
}

/** A new device row with its token; the same phone's earlier pairing (any account) ends. */
async function insertDevice(
  tx: Db,
  accountId: number,
  input: { deviceUuid: string; name: string | null; platform?: string; appVersion: string | null },
  now: Date,
): Promise<{ token: string; row: DeviceRow }> {
  await tx`
    UPDATE devices SET ended_at = ${now}, end_reason = 'replaced'
     WHERE device_uuid = ${input.deviceUuid} AND ended_at IS NULL`;
  const token = newToken();
  const [d] = await tx<DeviceRow[]>`
    INSERT INTO devices (public_id, account_id, device_uuid, name, platform, app_version, token_hash,
                         paired_at, last_seen_at)
    VALUES (${newPublicId('dev')}, ${accountId}, ${input.deviceUuid}, ${input.name}, ${input.platform ?? 'android'},
            ${input.appVersion}, ${tokenHash(token)}, ${now}, ${now})
    RETURNING *`;
  return { token, row: d! };
}

/** Devices an account without a running subscription may sign in (store buyers, before buying). */
export const SIGNIN_DEVICES_WITHOUT_SUBSCRIPTION = 5;

/**
 * Signs a device in to an account without a pairing code (sign-in in the app: Google, e-mail
 * code). With a running subscription its device limit applies, as for pairing; without one a
 * few devices may sign in, so the purchase can be made. Call inside a transaction.
 */
export async function registerDevice(
  tx: Db,
  account: Account,
  input: Omit<PairInput, 'code'>,
): Promise<
  | { ok: true; token: string; device: Device }
  | { ok: false; problem: 'device_limit'; seats: number }
> {
  const now = input.now ?? new Date();
  await tx`SELECT id FROM accounts WHERE id = ${account.id} FOR UPDATE`;
  const ent = await accountEntitlements(tx, account, now);
  const seats = ent.active ? ent.seats : SIGNIN_DEVICES_WITHOUT_SUBSCRIPTION;
  const [n] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM devices
     WHERE account_id = ${account.id} AND ended_at IS NULL AND device_uuid <> ${input.deviceUuid}`;
  if ((n?.n ?? 0) >= seats) return { ok: false, problem: 'device_limit', seats };
  const { token, row } = await insertDevice(
    tx,
    account.id,
    {
      deviceUuid: input.deviceUuid,
      name: input.name?.trim().slice(0, 80) || null,
      platform: input.platform,
      appVersion: input.appVersion?.trim().slice(0, 40) || null,
    },
    now,
  );
  return { ok: true, token, device: toDevice(row) };
}

export type TokenLookup =
  | { ok: true; device: Device; account: Account }
  | { ok: false; problem: 'invalid_token' }
  | {
      ok: false;
      problem: 'unpaired';
      reason: EndReason;
      since: Date;
      successorName: string | null;
    };

/** The device of a token; also how a disconnected one ended. Updates last seen (hourly). */
export async function deviceByToken(
  db: Db,
  token: string | null | undefined,
  meta: { appVersion?: string | null; now?: Date } = {},
): Promise<TokenLookup> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, problem: 'invalid_token' };
  const now = meta.now ?? new Date();
  const [d] = await db<DeviceRow[]>`SELECT * FROM devices WHERE token_hash = ${tokenHash(token)}`;
  if (!d) return { ok: false, problem: 'invalid_token' };
  if (d.ended_at) {
    return {
      ok: false,
      problem: 'unpaired',
      reason: d.end_reason ?? 'removed',
      since: d.ended_at,
      successorName: d.successor_name,
    };
  }
  const account = await accountById(db, Number(d.account_id));
  if (!account) return { ok: false, problem: 'invalid_token' };
  const version = meta.appVersion?.trim().slice(0, 40) || null;
  if (
    !d.last_seen_at ||
    now.getTime() - d.last_seen_at.getTime() > 3600_000 ||
    (version && version !== d.app_version)
  ) {
    await db`
      UPDATE devices SET last_seen_at = ${now}, app_version = coalesce(${version}, app_version)
       WHERE id = ${d.id}`;
  }
  return { ok: true, device: toDevice(d), account };
}

/** Ends a device's pairing: removed in the portal, or the app disconnecting itself. */
export async function endDevice(
  db: Db,
  accountId: number,
  devicePublicId: string,
  reason: 'removed' | 'disconnected',
  now = new Date(),
): Promise<boolean> {
  const r = await db`
    UPDATE devices SET ended_at = ${now}, end_reason = ${reason}
     WHERE account_id = ${accountId} AND public_id = ${devicePublicId} AND ended_at IS NULL`;
  return r.count > 0;
}

/** Removed devices after a year and old pairing codes (worker). */
export async function deleteOldDevices(db: Db, now = new Date()): Promise<number> {
  const codes =
    await db`DELETE FROM pairing_codes WHERE expires_at < ${now}::timestamptz - interval '7 days'`;
  const devices =
    await db`DELETE FROM devices WHERE ended_at < ${now}::timestamptz - interval '1 year'`;
  return codes.count + devices.count;
}

/** Was a transfer code of this device used already (the app polls while showing it)? */
export async function transferredTo(db: Db, deviceId: number): Promise<string | null> {
  const [d] = await db<{ end_reason: string | null; successor_name: string | null }[]>`
    SELECT end_reason, successor_name FROM devices WHERE id = ${deviceId}`;
  return d?.end_reason === 'transferred' ? (d.successor_name ?? '') : null;
}

// ---------------------------------------------------------------------------
// What the app is told (GET /api/app/v1/status)
// ---------------------------------------------------------------------------

export type AppStatus = {
  /** none: the account never had a subscription (the app shows the store offers) */
  status: 'active' | 'inactive' | 'none';
  server_time: string;
  valid_until: string;
  account: {
    id: string;
    email: string;
    name: string | null;
    /** goes with every app-store purchase */
    store_ref: string;
    email_verified: boolean;
  };
  device: { id: string; name: string | null; paired_at: string };
  subscription: {
    plan: string | null;
    state: Entitlements['state'];
    /** where it is managed: web (the portal), google_play, app_store; null without one */
    source: 'web' | 'google_play' | 'app_store' | null;
    manage_url: string | null;
    renews_at: string | null;
    ends_at: string | null;
    devices: { included: number; extra: number; in_use: number };
  };
  features: Entitlements['features'];
  webshop: { host: string } | null;
  services: { s3: { enabled: boolean }; pipeline: { enabled: boolean } };
  portal_url: string;
};

export async function appStatus(
  db: Db,
  account: Account,
  device: Device,
  opts: { baseUrl: string; now?: Date },
): Promise<AppStatus> {
  const now = opts.now ?? new Date();
  const [sub, services, inUse] = await Promise.all([
    subscriptionOf(db, account.id),
    accountServices(db, account.id),
    db<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM devices WHERE account_id = ${account.id} AND ended_at IS NULL`,
  ]);
  const ent = entitlements(sub, account, now, services);
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const portal = `${opts.baseUrl}${account.locale === 'de' ? '/de/konto' : '/account'}`;
  const manage = subscriptionManagement(sub, {
    portalUrl: `${opts.baseUrl}${account.locale === 'de' ? '/de/konto/abo' : '/account/subscription'}`,
  });
  return {
    status: ent.active ? 'active' : ent.state === 'none' ? 'none' : 'inactive',
    server_time: now.toISOString(),
    valid_until: ent.validUntil.toISOString(),
    account: {
      id: account.publicId,
      email: account.email,
      name: account.name,
      store_ref: account.storeRef,
      email_verified: account.emailVerified,
    },
    device: { id: device.publicId, name: device.name, paired_at: device.pairedAt.toISOString() },
    subscription: {
      plan: ent.plan,
      state: ent.state,
      source: manage.source,
      manage_url: manage.url,
      renews_at: iso(ent.renewsAt),
      ends_at: iso(ent.endsAt),
      devices: { included: ent.active ? 1 : 0, extra: ent.extraDevices, in_use: inUse[0]?.n ?? 0 },
    },
    features: ent.features,
    webshop: ent.features.webshop && ent.webshopHost ? { host: ent.webshopHost } : null,
    services: { s3: { enabled: ent.services.s3 }, pipeline: { enabled: ent.services.pipeline } },
    portal_url: portal,
  };
}

/** Where a subscription is managed (cancelled, changed): the portal or the app store. */
export function subscriptionManagement(
  sub: Subscription | null,
  opts: { portalUrl: string },
): { source: AppStatus['subscription']['source']; url: string | null } {
  if (!sub) return { source: null, url: null };
  if (sub.source === 'google_play' || sub.source === 'app_store') {
    return { source: sub.source, url: storeManageUrl(sub.source, sub.storeProductId) };
  }
  return { source: 'web', url: opts.portalUrl };
}
