import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createSql, type Sql } from '../../../packages/core/src/db.ts';
import { runMigrations } from '../../../packages/core/src/migrations.ts';
import { LICENSE_MIGRATIONS_DIR } from '../src/config.ts';
import { createLicenseServer } from '../src/server.ts';
import { activate } from '../src/store.ts';

const SHOP_TOKEN = 'shop-token-for-tests-0123456789abcdef';
const name = `license_it_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
let sql: Sql;
let server: Server;
let base: string;

before(async () => {
  execFileSync('createdb', [name]);
  const user = encodeURIComponent(process.env.PGUSER ?? process.env.USER ?? 'postgres');
  const pass = process.env.PGPASSWORD ? `:${encodeURIComponent(process.env.PGPASSWORD)}` : '';
  const url = `postgres://${user}${pass}@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${name}`;
  sql = createSql(url, { max: 5 });
  await runMigrations(sql, () => {}, LICENSE_MIGRATIONS_DIR);
  server = createLicenseServer({
    sql,
    masterKey: Buffer.alloc(32, 3),
    shopToken: SHOP_TOKEN,
    activateLimit: 1000,
    log: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await sql.end({ timeout: 5 });
  execFileSync('dropdb', ['--if-exists', name]);
});

type Json = Record<string, unknown> & { licenses?: Record<string, unknown>[] };

async function call(
  method: string,
  path: string,
  body?: unknown,
  token: string | null = SHOP_TOKEN,
): Promise<{ status: number; json: Json }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token && path.startsWith('/v1/shop/') ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

test('health', async () => {
  assert.deepEqual(await call('GET', '/health'), { status: 200, json: { ok: true } });
});

test('the shop endpoints need the shop token', async () => {
  assert.equal((await call('POST', '/v1/shop/licenses', {}, null)).status, 401);
  assert.equal((await call('POST', '/v1/shop/licenses', {}, 'wrong')).status, 401);
  assert.equal((await call('GET', '/v1/shop/licenses?email=a@b.at', undefined, null)).status, 401);
});

test('a licence moves from device to device; the old one learns it on its next check', async () => {
  const issued = await call('POST', '/v1/shop/licenses', {
    order_ref: 'R-1001',
    email: 'Max@Example.com',
    name: 'Max',
  });
  assert.equal(issued.status, 201);
  const lic = issued.json.licenses![0]!;
  const key = lic.key as string;
  assert.match(key, /^CS-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  assert.equal(lic.qr, key);
  assert.equal(lic.active_device, null);

  // the same order again: the same licence, not a second one
  const again = await call('POST', '/v1/shop/licenses', {
    order_ref: 'R-1001',
    email: 'max@example.com',
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.licenses![0]!.key, key);
  assert.equal(
    (await call('POST', '/v1/shop/licenses', { order_ref: 'R-1001', count: 2 })).status,
    409,
  );

  // first device, key typed sloppily
  const a = await call('POST', '/v1/activate', {
    key: key.toLowerCase().replace(/-/g, ' '),
    device_id: 'device-a',
    device_name: 'Pixel 8',
    app_version: '1.2.30',
  });
  assert.equal(a.status, 200);
  assert.equal(a.json.license_id, lic.id);
  const tokenA = a.json.token as string;
  assert.deepEqual((await call('POST', '/v1/check', { token: tokenA })).json, { status: 'active' });

  // the second device takes it over
  const b = await call('POST', '/v1/activate', {
    key,
    device_id: 'device-b',
    device_name: 'Galaxy S24',
  });
  assert.equal(b.status, 200);
  const tokenB = b.json.token as string;
  const old = await call('POST', '/v1/check', { token: tokenA });
  assert.equal(old.json.status, 'suspended');
  assert.equal(old.json.device_name, 'Galaxy S24');
  assert.ok(Date.parse(old.json.since as string) > 0);
  assert.deepEqual((await call('POST', '/v1/check', { token: tokenB })).json, { status: 'active' });

  // the shop sees where it is (for support and "send my licence again")
  const found = await call('GET', '/v1/shop/licenses?email=MAX@example.com');
  assert.equal(found.json.licenses!.length, 1);
  const view = found.json.licenses![0]!;
  assert.equal(view.key, key);
  assert.equal((view.active_device as Record<string, unknown>).name, 'Galaxy S24');
  assert.equal(view.activations, 2);
  assert.equal(
    (await call('GET', `/v1/shop/licenses?key=${encodeURIComponent(key)}`)).json.licenses![0]!.id,
    lic.id,
  );
  assert.equal((await call('GET', `/v1/shop/licenses/${lic.id as string}`)).json.key, key);

  // the same device again (data cleared): a new token for it, nobody else is affected
  const b2 = await call('POST', '/v1/activate', {
    key,
    device_id: 'device-b',
    device_name: 'Galaxy S24',
  });
  assert.equal((await call('POST', '/v1/check', { token: b2.json.token })).json.status, 'active');
  assert.equal((await call('POST', '/v1/check', { token: tokenB })).status, 404);

  // the first device scans the QR code again: it is back, the second one is suspended
  const a2 = await call('POST', '/v1/activate', {
    key,
    device_id: 'device-a',
    device_name: 'Pixel 8',
  });
  assert.equal((await call('POST', '/v1/check', { token: a2.json.token })).json.status, 'active');
  const nowB = await call('POST', '/v1/check', { token: b2.json.token });
  assert.equal(nowB.json.status, 'suspended');
  assert.equal(nowB.json.device_name, 'Pixel 8');

  // revoked (refund): every device stops, no new activation
  const revoked = await call('POST', `/v1/shop/licenses/${lic.id as string}/revoke`, {
    reason: 'refund',
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual((await call('POST', '/v1/check', { token: a2.json.token })).json, {
    status: 'revoked',
  });
  const late = await call('POST', '/v1/activate', { key, device_id: 'device-c' });
  assert.equal(late.status, 410);
  assert.equal(late.json.error, 'revoked');
});

test('wrong keys and tokens', async () => {
  const unknown = await call('POST', '/v1/activate', {
    key: 'CS-00000-00000-00000-00000',
    device_id: 'x',
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error, 'unknown_key');
  assert.equal(
    (await call('POST', '/v1/activate', { key: 'hello', device_id: 'x' })).json.error,
    'invalid_key',
  );
  const issued = await call('POST', '/v1/shop/licenses', { email: 'x@example.com' });
  const key = issued.json.licenses![0]!.key;
  assert.equal((await call('POST', '/v1/activate', { key })).json.error, 'invalid_device');
  assert.equal((await call('POST', '/v1/check', { token: 'nope' })).status, 404);
  assert.equal((await call('POST', '/v1/check', {})).json.error, 'invalid_token');
  const bad = await fetch(`${base}/v1/check`, { method: 'POST', body: 'not json' });
  assert.equal(bad.status, 400);
  assert.equal((await call('GET', '/v1/nothing')).status, 404);
});

test('an order can hold several licences', async () => {
  const r = await call('POST', '/v1/shop/licenses', {
    order_ref: 'R-2002',
    email: 'team@example.com',
    count: 3,
  });
  assert.equal(r.status, 201);
  const keys = new Set(r.json.licenses!.map((l) => l.key));
  assert.equal(keys.size, 3);
});

test('two devices activating at the same moment: exactly one is active', async () => {
  const issued = await call('POST', '/v1/shop/licenses', { email: 'race@example.com' });
  const key = issued.json.licenses![0]!.key as string;
  await Promise.all(
    ['r1', 'r2', 'r3', 'r4'].map((d) => activate(sql, key, { deviceId: d, deviceName: d })),
  );
  const [row] = await sql<{ active: number; total: number }[]>`
    SELECT count(*) FILTER (WHERE a.ended_at IS NULL)::int AS active, count(*)::int AS total
    FROM activations a JOIN licenses l ON l.id = a.license_id WHERE l.email = 'race@example.com'`;
  assert.equal(row?.active, 1);
  assert.equal(row?.total, 4);
});
