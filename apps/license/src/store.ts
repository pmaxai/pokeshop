import { decryptSecret, encryptSecret } from '../../../packages/core/src/secrets.ts';
import type { Sql } from '../../../packages/core/src/db.ts';
import {
  formatKey,
  generateKey,
  keyHash,
  keyHint,
  newLicenseId,
  newToken,
  normalizeKey,
  tokenHash,
} from './keys.ts';

/**
 * Licences and activations. One licence is active on one device at a time: activating it
 * on another device ends the current activation (the partial unique index in the migration
 * keeps it that way even under concurrent requests). A device learns that it was replaced
 * on its next check; until then, and whenever it is offline, it keeps working.
 */

export class LicenseError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type LicenseRow = {
  id: string;
  key_enc: string;
  key_hint: string;
  email: string | null;
  name: string | null;
  order_ref: string | null;
  order_seq: number;
  note: string | null;
  created_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
};

export type ActivationRow = {
  id: number;
  license_id: string;
  device_id: string;
  device_name: string | null;
  app_version: string | null;
  created_at: Date;
  last_seen_at: Date;
  ended_at: Date | null;
  replaced_by: number | null;
};

export type IssueInput = {
  email?: string | null;
  name?: string | null;
  orderRef?: string | null;
  count?: number;
  note?: string | null;
};

export type IssuedLicense = { id: string; key: string; createdAt: Date; created: boolean };

/**
 * Creates licences. With an order reference it is idempotent: the same order gets the same
 * licences back (a retry after a lost answer never makes a second set).
 */
export async function issueLicenses(
  sql: Sql,
  masterKey: Buffer,
  input: IssueInput,
): Promise<IssuedLicense[]> {
  const count = input.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new LicenseError(400, 'invalid_count', 'count must be 1–50');
  }
  return sql.begin(async (tx) => {
    if (input.orderRef) {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'license-order:' + input.orderRef}))`;
      const existing = await tx<LicenseRow[]>`
        SELECT * FROM licenses WHERE order_ref = ${input.orderRef} ORDER BY order_seq`;
      if (existing.length > 0) {
        if (existing.length !== count) {
          throw new LicenseError(
            409,
            'order_mismatch',
            `order ${input.orderRef} already has ${existing.length} licence(s)`,
          );
        }
        return existing.map((r) => ({
          id: r.id,
          key: decryptKey(r, masterKey),
          createdAt: r.created_at,
          created: false,
        }));
      }
    }
    const out: IssuedLicense[] = [];
    for (let seq = 1; seq <= count; seq++) {
      const key = generateKey();
      const body = normalizeKey(key)!;
      const [row] = await tx<{ id: string; created_at: Date }[]>`
        INSERT INTO licenses (id, key_hash, key_enc, key_hint, email, name, order_ref, order_seq, note)
        VALUES (${newLicenseId()}, ${keyHash(body)}, ${encryptSecret(body, masterKey)}, ${keyHint(body)},
                ${input.email?.trim() || null}, ${input.name?.trim() || null}, ${input.orderRef ?? null},
                ${seq}, ${input.note ?? null})
        RETURNING id, created_at`;
      out.push({ id: row!.id, key, createdAt: row!.created_at, created: true });
    }
    return out;
  });
}

export function decryptKey(row: Pick<LicenseRow, 'key_enc'>, masterKey: Buffer): string {
  return formatKey(decryptSecret(row.key_enc, masterKey));
}

export type DeviceInput = {
  deviceId: string;
  deviceName?: string | null;
  appVersion?: string | null;
};

export type Activation = { licenseId: string; token: string; since: Date };

/** Activates the licence on this device; the device that had it is replaced. */
export async function activate(sql: Sql, key: string, device: DeviceInput): Promise<Activation> {
  const body = normalizeKey(key);
  if (!body) throw new LicenseError(400, 'invalid_key', 'this is not a licence key');
  if (!device.deviceId || device.deviceId.length > 100) {
    throw new LicenseError(400, 'invalid_device', 'device_id is missing');
  }
  return sql.begin(async (tx) => {
    const [lic] = await tx<LicenseRow[]>`
      SELECT * FROM licenses WHERE key_hash = ${keyHash(body)} FOR UPDATE`;
    if (!lic) throw new LicenseError(404, 'unknown_key', 'unknown licence key');
    if (lic.revoked_at) throw new LicenseError(410, 'revoked', 'this licence was revoked');
    const token = newToken();
    const name = clip(device.deviceName, 80);
    const version = clip(device.appVersion, 40);
    const [current] = await tx<ActivationRow[]>`
      SELECT * FROM activations WHERE license_id = ${lic.id} AND ended_at IS NULL`;
    if (current && current.device_id === device.deviceId) {
      // the same device again (e.g. its data was cleared): a new token, nobody is replaced
      await tx`
        UPDATE activations SET token_hash = ${tokenHash(token)}, device_name = ${name},
               app_version = ${version}, last_seen_at = now()
        WHERE id = ${current.id}`;
      return { licenseId: lic.id, token, since: current.created_at };
    }
    if (current) await tx`UPDATE activations SET ended_at = now() WHERE id = ${current.id}`;
    const [row] = await tx<{ id: number; created_at: Date }[]>`
      INSERT INTO activations (license_id, token_hash, device_id, device_name, app_version)
      VALUES (${lic.id}, ${tokenHash(token)}, ${device.deviceId}, ${name}, ${version})
      RETURNING id, created_at`;
    if (current) await tx`UPDATE activations SET replaced_by = ${row!.id} WHERE id = ${current.id}`;
    return { licenseId: lic.id, token, since: row!.created_at };
  });
}

export type CheckResult =
  | { status: 'active' }
  | { status: 'suspended'; since: Date; deviceName: string | null }
  | { status: 'revoked' };

/** What a device holding [token] may do: go on, or stop because another device took over. */
export async function check(
  sql: Sql,
  token: string,
  appVersion?: string | null,
): Promise<CheckResult> {
  if (!token || token.length > 200)
    throw new LicenseError(400, 'invalid_token', 'token is missing');
  const [a] = await sql<(ActivationRow & { revoked_at: Date | null })[]>`
    SELECT a.*, l.revoked_at FROM activations a JOIN licenses l ON l.id = a.license_id
    WHERE a.token_hash = ${tokenHash(token)}`;
  if (!a) throw new LicenseError(404, 'unknown_activation', 'unknown activation');
  if (a.revoked_at) return { status: 'revoked' };
  if (a.ended_at === null) {
    await sql`
      UPDATE activations SET last_seen_at = now(), app_version = coalesce(${clip(appVersion, 40)}, app_version)
      WHERE id = ${a.id}`;
    return { status: 'active' };
  }
  const [next] = a.replaced_by
    ? await sql<{ device_name: string | null }[]>`
        SELECT device_name FROM activations WHERE id = ${a.replaced_by}`
    : [];
  return { status: 'suspended', since: a.ended_at, deviceName: next?.device_name ?? null };
}

export type LicenseView = {
  id: string;
  key: string;
  email: string | null;
  name: string | null;
  orderRef: string | null;
  note: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  activeDevice: { name: string | null; since: Date; lastSeen: Date } | null;
  activations: number;
};

/** Licences found by ids, key or the buyer's e-mail (case doesn't matter). */
export async function findLicenses(
  db: Sql,
  masterKey: Buffer,
  by: { ids?: string[]; key?: string; email?: string },
): Promise<LicenseView[]> {
  const body = by.key ? normalizeKey(by.key) : null;
  if (by.key && !body) return [];
  const rows = await db<(LicenseRow & { active: ActivationRow | null; activations: number })[]>`
    SELECT l.*,
           (SELECT to_jsonb(a) FROM activations a WHERE a.license_id = l.id AND a.ended_at IS NULL) AS active,
           (SELECT count(*)::int FROM activations a WHERE a.license_id = l.id) AS activations
    FROM licenses l
    WHERE ${
      by.ids
        ? db`l.id = ANY(${by.ids})`
        : body
          ? db`l.key_hash = ${keyHash(body)}`
          : db`lower(l.email) = lower(${(by.email ?? '').trim()})`
    }
    ORDER BY l.created_at, l.order_seq`;
  return rows.map((r) => ({
    id: r.id,
    key: decryptKey(r, masterKey),
    email: r.email,
    name: r.name,
    orderRef: r.order_ref,
    note: r.note,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    revokeReason: r.revoke_reason,
    activeDevice: r.active
      ? {
          name: r.active.device_name,
          since: new Date(r.active.created_at),
          lastSeen: new Date(r.active.last_seen_at),
        }
      : null,
    activations: r.activations,
  }));
}

/** Revokes a licence (refund, chargeback): its device stops on the next check. */
export async function revoke(sql: Sql, id: string, reason: string): Promise<Date> {
  const [row] = await sql<{ revoked_at: Date }[]>`
    UPDATE licenses SET revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, ${reason})
    WHERE id = ${id} RETURNING revoked_at`;
  if (!row) throw new LicenseError(404, 'unknown_license', 'unknown licence');
  return row.revoked_at;
}

function clip(v: string | null | undefined, max: number): string | null {
  const s = v?.trim();
  return s ? s.slice(0, max) : null;
}
