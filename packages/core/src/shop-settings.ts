// Settings the owner changes in the admin: delivery countries and their limits, the high-value
// threshold, reservation time, who gets shop mails, the carrier's tracking link.
import { z } from 'zod';
import type { Db, Sql } from './db.ts';

/** "12,50" or "12.50" or "12" → 1250; empty → null. */
export function euroToCents(v: string): number | null {
  const t = v.trim().replace(/\s|€/g, '');
  if (!t) return null;
  const n = Number(t.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000)
    throw new SettingsError(`Betrag „${v}“ nicht verstanden`);
  return Math.round(n * 100);
}

export class SettingsError extends Error {}

export type CountrySettingsRow = {
  code: string;
  delivery_enabled: boolean;
  is_eu: boolean;
  min_order_cents: number;
  insured_rate_bp: number;
  insured_minimum_cents: number;
  insured_max_order_cents: number | null;
  delivery_time_de: string | null;
  delivery_time_en: string | null;
};

export async function countrySettings(db: Db): Promise<CountrySettingsRow[]> {
  return db<CountrySettingsRow[]>`
    SELECT code, delivery_enabled, is_eu, min_order_cents, insured_rate_bp, insured_minimum_cents,
           insured_max_order_cents, delivery_time_de, delivery_time_en
      FROM countries ORDER BY delivery_enabled DESC, code = 'AT' DESC, code`;
}

export type CountryUpdate = {
  code: string;
  deliveryEnabled: boolean;
  minOrderCents: number;
  insuredRateBp: number;
  insuredMinimumCents: number;
  insuredMaxOrderCents: number | null;
  deliveryTimeDe: string | null;
  deliveryTimeEn: string | null;
};

export async function updateCountries(sql: Sql, rows: CountryUpdate[]): Promise<void> {
  if (!rows.some((r) => r.deliveryEnabled))
    throw new SettingsError('Mindestens ein Lieferland muss aktiv sein.');
  for (const r of rows) {
    if (r.insuredRateBp < 0 || r.insuredRateBp > 10000)
      throw new SettingsError(`${r.code}: Versicherungssatz 0–100 %`);
  }
  await sql.begin(async (tx) => {
    for (const r of rows) {
      await tx`
        UPDATE countries SET delivery_enabled = ${r.deliveryEnabled}, min_order_cents = ${r.minOrderCents},
               insured_rate_bp = ${r.insuredRateBp}, insured_minimum_cents = ${r.insuredMinimumCents},
               insured_max_order_cents = ${r.insuredMaxOrderCents},
               delivery_time_de = ${r.deliveryTimeDe}, delivery_time_en = ${r.deliveryTimeEn},
               updated_at = now()
         WHERE code = ${r.code}`;
    }
  });
}

export const GeneralSettings = z.object({
  high_value_threshold_cents: z.number().int().min(0).max(10_000_000).nullable(),
  reservation_minutes: z.number().int().min(5).max(30),
  admin_alert_recipients: z.array(z.email()).min(1).max(10),
  tracking_url: z
    .string()
    .trim()
    .regex(
      /^https:\/\/\S+\{number\}\S*$/,
      'Die Adresse muss mit https:// beginnen und {number} enthalten.',
    ),
});
export type GeneralSettings = z.infer<typeof GeneralSettings>;

export async function generalSettings(db: Db): Promise<GeneralSettings> {
  const rows = await db<{ key: string; value: unknown }[]>`
    SELECT key, value FROM settings
     WHERE key IN ('high_value_threshold_cents', 'reservation_minutes', 'admin_alert_recipients', 'carrier')`;
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    high_value_threshold_cents: (get('high_value_threshold_cents') as number | null) ?? null,
    reservation_minutes: Number(get('reservation_minutes') ?? 10),
    admin_alert_recipients: (get('admin_alert_recipients') as string[]) ?? [],
    tracking_url: (get('carrier') as { tracking_url?: string } | undefined)?.tracking_url ?? '',
  };
}

export async function saveGeneralSettings(sql: Sql, input: GeneralSettings): Promise<void> {
  const v = GeneralSettings.safeParse(input);
  if (!v.success) throw new SettingsError(v.error.issues.map((i) => i.message).join(' '));
  const s = v.data;
  await sql.begin(async (tx) => {
    const set = (key: string, value: unknown) =>
      tx`INSERT INTO settings (key, value) VALUES (${key}, ${tx.json(value as never)})
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    await set('high_value_threshold_cents', s.high_value_threshold_cents);
    await set('reservation_minutes', s.reservation_minutes);
    await set('admin_alert_recipients', s.admin_alert_recipients);
    await tx`UPDATE settings SET value = jsonb_set(value, '{tracking_url}', ${tx.json(s.tracking_url as never)}),
                    updated_at = now()
              WHERE key = 'carrier'`;
  });
}
