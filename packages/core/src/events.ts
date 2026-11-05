// "Veranstaltungen": trading shows and other events with date, place and description.
import { z } from 'zod';
import type { Db, Sql } from './db.ts';

export type ShopEvent = {
  id: number;
  slug: string;
  status: 'draft' | 'published';
  title_de: string;
  title_en: string | null;
  starts_at: Date;
  ends_at: Date | null;
  venue: string | null;
  street: string | null;
  postcode: string | null;
  city: string;
  country: string;
  description_de: string | null;
  description_en: string | null;
  entry_fee: string | null;
  table_info: string | null;
  website_url: string | null;
};

const COLUMNS = `id, slug, status, title_de, title_en, starts_at, ends_at, venue, street, postcode, city,
  country, description_de, description_en, entry_fee, table_info, website_url`;

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'too_long')
    .transform((v) => v || null);

/** Date and time as typed in the admin (datetime-local, Vienna time). */
const localDateTime = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'invalid_date');

export const EventInput = z
  .object({
    title_de: z.string().trim().min(1, 'required').max(160, 'too_long'),
    title_en: text(160),
    starts_at: localDateTime,
    ends_at: z.union([localDateTime, z.literal('')]).transform((v) => v || null),
    venue: text(160),
    street: text(160),
    postcode: text(12),
    city: z.string().trim().min(1, 'required').max(80, 'too_long'),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'invalid'),
    description_de: text(6000),
    description_en: text(6000),
    entry_fee: text(200),
    table_info: text(400),
    website_url: z
      .string()
      .trim()
      .max(500, 'too_long')
      .refine((v) => v === '' || /^https?:\/\/[^\s]+$/.test(v), 'invalid_url')
      .transform((v) => v || null),
    status: z.enum(['draft', 'published']),
  })
  .refine((e) => !e.ends_at || e.ends_at >= e.starts_at, {
    path: ['ends_at'],
    message: 'before_start',
  });
export type EventInput = z.infer<typeof EventInput>;

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export async function upcomingEvents(db: Db, now = new Date()): Promise<ShopEvent[]> {
  return db<ShopEvent[]>`
    SELECT ${db.unsafe(COLUMNS)} FROM shop_events
     WHERE status = 'published' AND coalesce(ends_at, starts_at + interval '1 day') >= ${now}
     ORDER BY starts_at`;
}

export async function pastEvents(db: Db, now = new Date(), limit = 12): Promise<ShopEvent[]> {
  return db<ShopEvent[]>`
    SELECT ${db.unsafe(COLUMNS)} FROM shop_events
     WHERE status = 'published' AND coalesce(ends_at, starts_at + interval '1 day') < ${now}
     ORDER BY starts_at DESC LIMIT ${limit}`;
}

export async function eventBySlug(db: Db, slug: string): Promise<ShopEvent | null> {
  const [e] = await db<ShopEvent[]>`
    SELECT ${db.unsafe(COLUMNS)} FROM shop_events WHERE slug = ${slug} AND status = 'published'`;
  return e ?? null;
}

export async function getEvent(db: Db, id: number): Promise<ShopEvent | null> {
  const [e] = await db<ShopEvent[]>`SELECT ${db.unsafe(COLUMNS)} FROM shop_events WHERE id = ${id}`;
  return e ?? null;
}

export async function adminEvents(db: Db): Promise<ShopEvent[]> {
  return db<
    ShopEvent[]
  >`SELECT ${db.unsafe(COLUMNS)} FROM shop_events ORDER BY starts_at DESC LIMIT 300`;
}

/** Creates or updates an event; the address in the URL is made from title, city and date once. */
export async function saveEvent(sql: Sql, id: number | null, e: EventInput): Promise<number> {
  const values = {
    status: e.status,
    title_de: e.title_de,
    title_en: e.title_en,
    venue: e.venue,
    street: e.street,
    postcode: e.postcode,
    city: e.city,
    country: e.country,
    description_de: e.description_de,
    description_en: e.description_en,
    entry_fee: e.entry_fee,
    table_info: e.table_info,
    website_url: e.website_url,
  };
  return sql.begin(async (tx) => {
    if (id !== null) {
      const r = await tx<{ id: number }[]>`
        UPDATE shop_events SET ${tx(values as never)},
               starts_at = (${e.starts_at}::text::timestamp AT TIME ZONE 'Europe/Vienna'),
               ends_at = (${e.ends_at}::text::timestamp AT TIME ZONE 'Europe/Vienna')
         WHERE id = ${id} RETURNING id`;
      if (!r[0]) throw new Error('event not found');
      return id;
    }
    const base = slugify(`${e.title_de} ${e.city} ${e.starts_at.slice(0, 10)}`) || 'veranstaltung';
    let slug = base;
    for (let n = 2; (await tx`SELECT 1 FROM shop_events WHERE slug = ${slug}`).length; n++)
      slug = `${base}-${n}`;
    const [r] = await tx<{ id: number }[]>`
      INSERT INTO shop_events (slug, status, title_de, title_en, starts_at, ends_at, venue, street,
                               postcode, city, country, description_de, description_en, entry_fee,
                               table_info, website_url)
      VALUES (${slug}, ${e.status}, ${e.title_de}, ${e.title_en},
              (${e.starts_at}::text::timestamp AT TIME ZONE 'Europe/Vienna'),
              (${e.ends_at}::text::timestamp AT TIME ZONE 'Europe/Vienna'),
              ${e.venue}, ${e.street}, ${e.postcode}, ${e.city}, ${e.country}, ${e.description_de},
              ${e.description_en}, ${e.entry_fee}, ${e.table_info}, ${e.website_url})
      RETURNING id`;
    return r!.id;
  });
}

export async function deleteEvent(sql: Sql, id: number): Promise<void> {
  await sql`DELETE FROM shop_events WHERE id = ${id}`;
}
