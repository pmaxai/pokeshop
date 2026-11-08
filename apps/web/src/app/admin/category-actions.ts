'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createCategory, deleteCategory, updateCategory } from '@pokeshop/core/categories';
import { ApiError } from '@pokeshop/core/errors';
import { db } from '@/server/config';
import { audit, requireAdmin } from '@/server/admin-auth';

const PATH = '/admin/kategorien';

const back = (notice: string, kind: 'ok' | 'err' = 'ok'): never =>
  redirect(`${PATH}?${kind}=${encodeURIComponent(notice)}`);

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

const position = (f: FormData) => {
  const v = str(f, 'position');
  return v === '' ? 0 : Number(v);
};

function messageOf(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Unerwarteter Fehler, bitte erneut versuchen.';
  if (e.code === 'conflict') return 'Diese Kategorie gibt es schon (gleiche Kurzform).';
  if (e.fields?.name_de || e.fields?.name_en) return 'Namen: 1 bis 60 Zeichen.';
  if (e.fields?.position) return 'Reihenfolge: bitte eine ganze Zahl.';
  if (e.fields?.slug) return 'Die Kurzform braucht Buchstaben oder Ziffern.';
  return e.message;
}

export async function createCategoryAction(form: FormData) {
  const user = await requireAdmin();
  let name = '';
  try {
    const c = await createCategory(db(), {
      nameDe: str(form, 'name_de'),
      nameEn: str(form, 'name_en'),
      slug: str(form, 'slug'),
      position: position(form),
    });
    name = c.nameDe;
    await audit(user, 'category.create', 'category', c.slug, null, c);
  } catch (e) {
    back(messageOf(e), 'err');
  }
  revalidatePath('/', 'layout');
  back(`„${name}“ angelegt.`);
}

export async function updateCategoryAction(form: FormData) {
  const user = await requireAdmin();
  const id = Number(str(form, 'id'));
  try {
    const input = {
      nameDe: str(form, 'name_de'),
      nameEn: str(form, 'name_en'),
      position: position(form),
    };
    await updateCategory(db(), id, input);
    await audit(user, 'category.update', 'category', id, null, input);
  } catch (e) {
    back(messageOf(e), 'err');
  }
  revalidatePath('/', 'layout');
  back('Gespeichert.');
}

export async function deleteCategoryAction(form: FormData) {
  const user = await requireAdmin();
  const id = Number(str(form, 'id'));
  await deleteCategory(db(), id);
  await audit(user, 'category.delete', 'category', id, { name: str(form, 'name') }, null);
  revalidatePath('/', 'layout');
  back('Kategorie gelöscht. Die Produkte selbst bleiben unverändert.');
}
