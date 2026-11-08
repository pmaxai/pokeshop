import { listCategories } from '@pokeshop/core/categories';
import { signed } from '@/server/signed-api';
import { db } from '@/server/config';

export const dynamic = 'force-dynamic';

/** The categories products can be put in (field `categories` on products). Managed in the admin. */
export const GET = signed('products:read', async () => {
  const items = (await listCategories(db())).map((c) => ({
    slug: c.slug,
    name_de: c.nameDe,
    name_en: c.nameEn,
    position: c.position,
  }));
  return { status: 200, body: { items } };
});
