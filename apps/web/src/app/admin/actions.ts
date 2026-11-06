'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { parse, ProductPatch, StockChange } from '@pokeshop/core/api-schemas';
import { ApiError } from '@pokeshop/core/errors';
import { changeStock, getProduct, patchProduct } from '@pokeshop/core/products';
import { createApiClient, revokeApiClient } from '@pokeshop/core/api-clients';
import { enqueueJob } from '@pokeshop/core/jobs';
import { apiMasterKey, config, db } from '@/server/config';
import {
  audit,
  createSession,
  devLoginAllowed,
  endSession,
  requireAdmin,
} from '@/server/admin-auth';

const back = (path: string, notice: string, kind: 'ok' | 'err' = 'ok'): never =>
  redirect(`${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(notice)}`);

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

function euroToCents(v: string): number | undefined {
  if (!v) return undefined;
  const n = Number(
    v
      .replace(/\s/g, '')
      .replace(/\.(?=\d{3}(\D|$))/g, '')
      .replace(',', '.'),
  );
  if (!Number.isFinite(n) || n < 0) throw new ApiError(422, 'validation', 'Preis nicht verstanden');
  return Math.round(n * 100);
}

const FIELD_NAMES: Record<string, string> = {
  storage_location: 'Box',
  from: 'Von Box',
  to: 'Nach Box',
  delta: 'Anzahl',
  set: 'Anzahl',
  move: 'Anzahl',
  name_de: 'Name (Deutsch)',
  name_en: 'Name (Englisch)',
  name_local: 'Name auf der Karte',
  price: 'Preis',
};

function messageOf(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Unerwarteter Fehler, bitte erneut versuchen.';
  switch (e.code) {
    case 'insufficient_stock':
      return 'In dieser Box sind nicht genug Karten (reservierte Karten zählen nicht mit).';
    case 'external_id_taken':
      return 'Diese externe ID gehört schon zu einem anderen Produkt.';
    case 'not_found':
      return 'Das Produkt gibt es nicht mehr.';
    case 'validation': {
      const fields = Object.entries(e.fields ?? {}).map(
        ([k, v]) => `${FIELD_NAMES[k.split('.')[0]!] ?? k}: ${v}`,
      );
      return `Bitte prüfen: ${fields.length ? fields.join('; ') : e.message}`;
    }
    default:
      return e.message;
  }
}

export async function saveProduct(form: FormData) {
  const user = await requireAdmin();
  const sku = str(form, 'sku');
  const path = `/admin/produkte/${encodeURIComponent(sku)}`;
  let warnings: string[] = [];
  try {
    const before = await getProduct(db(), sku);
    const cents = euroToCents(str(form, 'price'));
    const patch = parse(ProductPatch, {
      name_de: str(form, 'name_de') || undefined,
      name_en: str(form, 'name_en') || undefined,
      name_local: str(form, 'name_local') || undefined,
      description_de: str(form, 'description_de'),
      description_en: str(form, 'description_en'),
      price: cents === undefined ? undefined : { amount: cents, currency: 'EUR' },
      status: str(form, 'status') || undefined,
    });
    const r = await patchProduct(db(), sku, patch, { source: 'admin', id: user.email });
    warnings = r.warnings;
    await audit(user, 'product.update', 'product', sku, before, r.product);
  } catch (e) {
    back(path, messageOf(e), 'err');
  }
  revalidatePath('/', 'layout');
  back(
    path,
    warnings.length ? `Gespeichert, aber noch Entwurf: ${warnings.join(', ')}` : 'Gespeichert.',
    warnings.length ? 'err' : 'ok',
  );
}

export async function changeStockAction(form: FormData) {
  const user = await requireAdmin();
  const sku = str(form, 'sku');
  const path = `/admin/produkte/${encodeURIComponent(sku)}`;
  const mode = str(form, 'mode');
  const qty = Number(str(form, 'qty'));
  const reason = str(form, 'reason') || undefined;
  try {
    const body =
      mode === 'move'
        ? { move: qty, from: str(form, 'from'), to: str(form, 'to'), reason }
        : mode === 'set'
          ? { set: qty, storage_location: str(form, 'box'), reason }
          : { delta: mode === 'remove' ? -qty : qty, storage_location: str(form, 'box'), reason };
    const stock = await changeStock(db(), sku, parse(StockChange, body), {
      source: 'admin',
      id: user.email,
    });
    await audit(user, `stock.${mode}`, 'product', sku, null, { ...body, after: stock });
  } catch (e) {
    back(path, messageOf(e), 'err');
  }
  revalidatePath('/', 'layout');
  back(path, 'Bestand geändert.');
}

export async function retryImage(form: FormData) {
  await requireAdmin();
  const id = Number(str(form, 'image'));
  await db()`UPDATE product_images SET status = 'pending', attempts = 0, next_attempt_at = now(), error = NULL WHERE id = ${id}`;
  back(`/admin/produkte/${encodeURIComponent(str(form, 'sku'))}`, 'Bild wird erneut verarbeitet.');
}

export type CreateKeyState = { keyId?: string; secret?: string; error?: string };

export async function createApiKey(_prev: CreateKeyState, form: FormData): Promise<CreateKeyState> {
  const user = await requireAdmin('owner');
  const name = str(form, 'name');
  if (!name) return { error: 'Bitte einen Namen angeben, z. B. „Scanner Lager“.' };
  const ips = str(form, 'ips')
    .split(/[\s,]+/)
    .filter(Boolean);
  try {
    const { client, secret } = await createApiClient(
      db(),
      { name, ipAllowlist: ips, createdBy: user.email },
      apiMasterKey(),
    );
    await audit(user, 'api_client.create', 'api_client', client.id, null, {
      name,
      key_id: client.key_id,
      ips,
    });
    revalidatePath('/admin/api-keys');
    return { keyId: client.key_id, secret };
  } catch (e) {
    return {
      error: (e as Error).message.includes('cidr')
        ? 'IP-Adressen nicht verstanden (Beispiel: 203.0.113.7 oder 10.0.0.0/24).'
        : 'Schlüssel konnte nicht angelegt werden.',
    };
  }
}

export async function revokeApiKey(form: FormData) {
  const user = await requireAdmin('owner');
  const id = Number(str(form, 'id'));
  await revokeApiClient(db(), id);
  await audit(user, 'api_client.revoke', 'api_client', id, null, null);
  back('/admin/api-keys', 'Schlüssel gesperrt. Anfragen damit werden ab sofort abgelehnt.');
}

export async function requestCardSync() {
  const user = await requireAdmin('owner');
  const queued = await enqueueJob(
    db(),
    'tcgdex.sync',
    { requested_by: user.email },
    { dedupeKey: 'tcgdex.sync', maxAttempts: 3 },
  );
  back(
    '/admin',
    queued
      ? 'Kartendaten-Abgleich gestartet, er läuft im Hintergrund (etwa 2 Minuten).'
      : 'Ein Abgleich läuft bereits.',
  );
}

export async function logout() {
  await endSession();
  redirect('/admin/login');
}

export async function devLogin() {
  if (!devLoginAllowed()) redirect('/admin/login');
  await createSession({
    subject: 'dev',
    email: 'dev@localhost',
    name: 'Entwicklung',
    role: 'owner',
  });
  redirect('/admin');
}

void config;
