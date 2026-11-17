import type { NextRequest } from 'next/server';
import {
  MAX_STORE_DEVICES,
  setTestStoreState,
  storeDevicesOf,
  type StoreState,
} from '@pokeshop/core/store';
import { config, db } from '@/server/config';
import { apiError, jsonBody, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

const STATES = [
  'active',
  'renewed',
  'canceled',
  'grace',
  'on_hold',
  'paused',
  'expired',
  'refunded',
];

/**
 * Staging only: POST /api/app/v1/test/store-event { store_ref, state, devices? } moves the
 * account's latest test purchase (Google Play or App Store) to a state (renewal, cancel, grace,
 * expiry, refund) without waiting; `devices` (0–4) sets its extra devices (Google: add-ons;
 * App Store: the plan's extra-devices subscription, which follows the state).
 */
export async function POST(req: NextRequest) {
  if (!config.storeTestHooks) return apiError(404, 'not_found', 'Not found.');
  const b = await jsonBody(req);
  const storeRef = typeof b?.store_ref === 'string' ? b.store_ref : '';
  const state = typeof b?.state === 'string' ? b.state : '';
  const devices = b?.devices;
  const badDevices =
    devices !== undefined &&
    !(Number.isInteger(devices) && Number(devices) >= 0 && Number(devices) <= MAX_STORE_DEVICES);
  if (!STATES.includes(state) || badDevices) {
    return apiError(400, 'invalid_request', 'Check the request body.', {
      fields: { ...(badDevices ? { devices: 'invalid' } : { state: 'invalid' }) },
    });
  }
  const p = await setTestStoreState(
    db(),
    storeRef,
    state as StoreState | 'renewed' | 'refunded',
    new Date(),
    devices === undefined ? undefined : Number(devices),
  );
  if (!p) return apiError(404, 'not_found', 'No test purchase for this store_ref.');
  return ok({
    store: p.store,
    state: p.state,
    expires_at: p.expiresAt?.toISOString() ?? null,
    devices: await storeDevicesOf(db(), p),
  });
}
