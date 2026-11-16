import type { NextRequest } from 'next/server';
import { setTestStoreState, type StoreState } from '@pokeshop/core/store';
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
 * Staging only: POST /api/app/v1/test/store-event { store_ref, state } moves the account's latest
 * test purchase to a state (renewal, cancel, grace, expiry, refund) without waiting.
 */
export async function POST(req: NextRequest) {
  if (!config.storeTestHooks) return apiError(404, 'not_found', 'Not found.');
  const b = await jsonBody(req);
  const storeRef = typeof b?.store_ref === 'string' ? b.store_ref : '';
  const state = typeof b?.state === 'string' ? b.state : '';
  if (!STATES.includes(state)) {
    return apiError(400, 'invalid_request', 'Check the request body.', {
      fields: { state: 'invalid' },
    });
  }
  const p = await setTestStoreState(db(), storeRef, state as StoreState | 'renewed' | 'refunded');
  if (!p) return apiError(404, 'not_found', 'No test purchase for this store_ref.');
  return ok({ state: p.state, expires_at: p.expiresAt?.toISOString() ?? null });
}
