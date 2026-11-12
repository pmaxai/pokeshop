import { listCategories } from '@pokeshop/core/categories';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';
import {
  createCategoryAction,
  deleteCategoryAction,
  updateCategoryAction,
} from '../category-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Kategorien' };

export default async function Categories({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const categories = await listCategories(db());
  return (
    <AdminShell user={user} active="categories" notice={await searchParams}>
      <h1>Kategorien</h1>
      <p style={{ marginBottom: 'var(--s-4)', maxWidth: '65ch' }}>
        Kategorien wie „Cute“ erscheinen im Shop als Filter und auf der Kartenseite. Karten ordnest
        du beim Produkt zu – oder die Scanner-App schickt sie mit (Feld <code>categories</code> mit
        der Kurzform).
      </p>

      <section className="panel">
        <h2>Neue Kategorie</h2>
        <form action={createCategoryAction} className="form-grid" style={{ alignItems: 'start' }}>
          <label className="field">
            <span>Name (Deutsch)</span>
            <input name="name_de" required maxLength={60} placeholder="z. B. Süße Karten" />
          </label>
          <label className="field">
            <span>Name (Englisch)</span>
            <input name="name_en" maxLength={60} placeholder="z. B. Cute cards" />
            <small className="muted">Leer = wie Deutsch.</small>
          </label>
          <label className="field">
            <span>Kurzform (optional)</span>
            <input name="slug" maxLength={60} placeholder="z. B. cute" />
            <small className="muted">
              Steht in der Shop-Adresse und in der API. Leer = aus dem deutschen Namen. Später nicht
              mehr änderbar.
            </small>
          </label>
          <label className="field">
            <span>Reihenfolge</span>
            <input name="position" type="number" defaultValue={0} />
            <small className="muted">Kleinere Zahl steht weiter vorne.</small>
          </label>
          <div>
            <button className="btn btn--accent" type="submit">
              Kategorie anlegen
            </button>
          </div>
        </form>
      </section>

      <h2>Vorhandene Kategorien</h2>
      {categories.length === 0 ? (
        <p className="muted">Noch keine Kategorien angelegt.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name (Deutsch)</th>
                <th>Name (Englisch)</th>
                <th>Kurzform</th>
                <th>Reihenfolge</th>
                <th>Karten</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => {
                const form = `category-${c.id}`;
                return (
                  <tr key={c.id}>
                    <td>
                      <input
                        form={form}
                        name="name_de"
                        defaultValue={c.nameDe}
                        required
                        maxLength={60}
                        aria-label={`Name (Deutsch) von ${c.nameDe}`}
                      />
                    </td>
                    <td>
                      <input
                        form={form}
                        name="name_en"
                        defaultValue={c.nameEn}
                        maxLength={60}
                        aria-label={`Name (Englisch) von ${c.nameDe}`}
                      />
                    </td>
                    <td>
                      <code>{c.slug}</code>
                    </td>
                    <td>
                      <input
                        form={form}
                        name="position"
                        type="number"
                        defaultValue={c.position}
                        style={{ width: '6rem' }}
                        aria-label={`Reihenfolge von ${c.nameDe}`}
                      />
                    </td>
                    <td>
                      <a
                        href={`/de/karten?cat=${encodeURIComponent(c.slug)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {c.products}
                      </a>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
                        <form id={form} action={updateCategoryAction}>
                          <input type="hidden" name="id" value={c.id} />
                          <button className="btn btn--small" type="submit">
                            Speichern
                          </button>
                        </form>
                        <form action={deleteCategoryAction}>
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="name" value={c.nameDe} />
                          <button className="btn btn--quiet btn--small" type="submit">
                            Löschen
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
