/**
 * Categories ("Cute", "Trainer-Karten" …): a product can be in any number of them. The admin
 * manages the list; the admin and the scanning app (API field `categories`) put products in.
 */
import type { Db } from './db.ts';
import { ApiError } from './errors.ts';

export type Category = {
  id: number;
  slug: string;
  nameDe: string;
  nameEn: string;
  position: number;
  /** Products in this category (any status). */
  products: number;
};

/** "Süße Karten" → "suesse-karten". */
export function categorySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

function cleanName(v: string | undefined, field: string): string {
  const s = (v ?? '').trim().replace(/\s+/g, ' ');
  if (!s || s.length > 60) {
    throw new ApiError(422, 'validation', 'category name', { [field]: '1 to 60 characters' });
  }
  return s;
}

function cleanPosition(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return 0;
  if (!Number.isInteger(v) || Math.abs(v) > 100_000) {
    throw new ApiError(422, 'validation', 'position', { position: 'a whole number' });
  }
  return v;
}

export async function listCategories(db: Db): Promise<Category[]> {
  const rows = await db<
    {
      id: number;
      slug: string;
      name_de: string;
      name_en: string;
      position: number;
      products: number;
    }[]
  >`
    SELECT c.id, c.slug, c.name_de, c.name_en, c.position,
           (SELECT count(*)::int FROM product_categories pc WHERE pc.category_id = c.id) AS products
      FROM categories c ORDER BY c.position, c.name_de, c.id`;
  return rows.map((r) => ({
    id: Number(r.id),
    slug: r.slug,
    nameDe: r.name_de,
    nameEn: r.name_en,
    position: r.position,
    products: r.products,
  }));
}

export async function createCategory(
  db: Db,
  input: { nameDe: string; nameEn?: string; slug?: string; position?: number },
): Promise<Category> {
  const nameDe = cleanName(input.nameDe, 'name_de');
  const nameEn = input.nameEn?.trim() ? cleanName(input.nameEn, 'name_en') : nameDe;
  const slug = input.slug?.trim() ? categorySlug(input.slug) : categorySlug(nameDe);
  if (!slug) {
    throw new ApiError(422, 'validation', 'slug', { slug: 'needs letters or digits' });
  }
  const [taken] = await db`SELECT 1 FROM categories WHERE slug = ${slug}`;
  if (taken) throw new ApiError(409, 'conflict', `category "${slug}" exists already`);
  const [r] = await db<{ id: number }[]>`
    INSERT INTO categories (slug, name_de, name_en, position)
    VALUES (${slug}, ${nameDe}, ${nameEn}, ${cleanPosition(input.position)}) RETURNING id`;
  return (await listCategories(db)).find((c) => c.id === Number(r!.id))!;
}

export async function updateCategory(
  db: Db,
  id: number,
  input: { nameDe: string; nameEn: string; position: number },
): Promise<void> {
  const nameDe = cleanName(input.nameDe, 'name_de');
  const nameEn = input.nameEn.trim() ? cleanName(input.nameEn, 'name_en') : nameDe;
  await db`
    UPDATE categories SET name_de = ${nameDe}, name_en = ${nameEn},
                          position = ${cleanPosition(input.position)}
     WHERE id = ${id}`;
}

export async function deleteCategory(db: Db, id: number): Promise<void> {
  await db`DELETE FROM categories WHERE id = ${id}`;
}

/** Slugs of a product's categories, in list order. */
export async function productCategorySlugs(db: Db, productId: number): Promise<string[]> {
  const rows = await db<{ slug: string }[]>`
    SELECT c.slug FROM product_categories pc JOIN categories c ON c.id = pc.category_id
     WHERE pc.product_id = ${productId} ORDER BY c.position, c.name_de, c.id`;
  return rows.map((r) => r.slug);
}

/**
 * Puts a product into exactly these categories (by slug). Unknown slugs are refused, so a typo
 * in the app does not silently drop a category.
 */
export async function setProductCategories(
  db: Db,
  productId: number,
  slugs: readonly string[],
): Promise<void> {
  const wanted = [...new Set(slugs.map((s) => s.trim().toLowerCase()).filter(Boolean))];
  const found = wanted.length
    ? await db<{ id: number; slug: string }[]>`
        SELECT id, slug FROM categories WHERE slug = ANY(${wanted}::text[])`
    : [];
  const unknown = wanted.filter((s) => !found.some((f) => f.slug === s));
  if (unknown.length) {
    throw new ApiError(422, 'validation', 'unknown category', {
      categories: `unknown: ${unknown.join(', ')}`,
    });
  }
  const ids = found.map((f) => Number(f.id));
  await db`
    DELETE FROM product_categories
     WHERE product_id = ${productId} AND NOT (category_id = ANY(${ids}::bigint[]))`;
  if (ids.length) {
    await db`
      INSERT INTO product_categories (product_id, category_id)
      SELECT ${productId}, unnest(${ids}::bigint[])
      ON CONFLICT DO NOTHING`;
  }
}
