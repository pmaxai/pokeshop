import { signed } from '@/server/signed-api';

export const dynamic = 'force-dynamic';

/** Signed ping: lets the scanning app check its key, secret and clock. */
export const GET = signed('products:read', async ({ client }) => ({
  status: 200,
  body: { ok: true, key_id: client.key_id, server_time: new Date().toISOString() },
}));
