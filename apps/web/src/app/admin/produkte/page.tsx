import { formatEuro } from '@pokeshop/core';
import { cardNameText, rowNames } from '@pokeshop/core/catalog';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../AdminShell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Produkte' };

const PAGE = 50;

export default async function Products({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; box?: string; page?: string }>;
}) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const q = sp.q?.trim().toLowerCase().slice(0, 100);
  const status = ['draft', 'active', 'archived'].includes(sp.status ?? '') ? sp.status : undefined;
  const box = /^\d{3,10}$/.test(sp.box ?? '') ? sp.box : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const sql = db();
  const where = sql`
    true
    ${q ? sql`AND (${q} <% p.search_text OR p.search_text LIKE ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'} OR p.external_id = ${sp.q!.trim()})` : sql``}
    ${status ? sql`AND p.status = ${status}` : sql``}
    ${box ? sql`AND EXISTS (SELECT 1 FROM stock_locations s WHERE s.product_id = p.id AND s.storage_location = ${box} AND s.quantity > 0)` : sql``}`;
  const [rows, [count]] = await Promise.all([
    sql<
      {
        sku: string;
        name_de: string;
        name_en: string;
        name_local: string | null;
        set_name_de: string | null;
        set_code: string;
        card_number: string;
        card_language: string;
        condition: string;
        status: string;
        price_cents: number | null;
        quantity: number;
        reserved: number;
        boxes: string | null;
        high_value: boolean;
      }[]
    >`
      SELECT p.sku, p.name_de, p.name_en, p.name_local, p.set_name_de, p.set_code, p.card_number, p.card_language, p.condition, p.status, p.price_cents,
             ps.quantity, ps.reserved, p.high_value,
             (SELECT string_agg(s.storage_location, ', ' ORDER BY length(s.storage_location), s.storage_location)
                FROM stock_locations s WHERE s.product_id = p.id AND s.quantity > 0) AS boxes
        FROM products p JOIN product_stock ps ON ps.product_id = p.id
       WHERE ${where}
       ORDER BY p.updated_at DESC, p.id DESC
       LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM products p WHERE ${where}`,
  ]);
  const pages = Math.max(1, Math.ceil((count?.n ?? 0) / PAGE));
  const link = (p: number) =>
    `?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(status ? { status } : {}), ...(box ? { box } : {}), page: String(p) })}`;
  return (
    <AdminShell user={user} active="products">
      <h1>Produkte</h1>
      <form className="toolbar" method="get">
        <label className="field">
          <span>Suche</span>
          <input
            name="q"
            defaultValue={sp.q}
            placeholder="Name, Set, Nummer, SKU oder externe ID"
            style={{ minWidth: '18rem' }}
          />
        </label>
        <label className="field">
          <span>Status</span>
          <select name="status" defaultValue={status ?? ''}>
            <option value="">alle</option>
            <option value="active">aktiv</option>
            <option value="draft">Entwurf</option>
            <option value="archived">archiviert</option>
          </select>
        </label>
        <label className="field">
          <span>Box</span>
          <input
            name="box"
            defaultValue={box}
            placeholder="z. B. 014"
            inputMode="numeric"
            style={{ width: '7rem' }}
          />
        </label>
        <button className="btn" type="submit">
          Anzeigen
        </button>
      </form>
      <p className="muted" style={{ marginBottom: 'var(--s-3)' }}>
        {count?.n ?? 0} Produkte
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Karte</th>
              <th>Set / Nummer</th>
              <th>Sprache</th>
              <th>Zustand</th>
              <th>Status</th>
              <th className="r">Preis</th>
              <th className="r">Bestand</th>
              <th>Boxen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sku}>
                <td>
                  <a href={`/admin/produkte/${encodeURIComponent(r.sku)}`}>
                    {cardNameText(rowNames(r, 'de'))}
                  </a>
                  {r.high_value ? ' (wertvoll)' : ''}
                  {!['DE', 'EN'].includes(r.card_language) && !r.name_local && (
                    <strong> · Name auf der Karte fehlt</strong>
                  )}
                  <br />
                  <span className="muted">{r.sku}</span>
                </td>
                <td>
                  {r.set_name_de ?? r.set_code} {r.card_number}
                </td>
                <td>{r.card_language}</td>
                <td>{r.condition}</td>
                <td>
                  <span className={`pill pill--${r.status}`}>
                    {r.status === 'active'
                      ? 'aktiv'
                      : r.status === 'draft'
                        ? 'Entwurf'
                        : 'archiviert'}
                  </span>
                </td>
                <td className="r">{r.price_cents === null ? '–' : formatEuro(r.price_cents)}</td>
                <td className="r">
                  {r.quantity}
                  {r.reserved ? ` (${r.reserved} reserviert)` : ''}
                </td>
                <td>{r.boxes ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <p className="pager">
          {page > 1 ? <a href={link(page - 1)}>Zurück</a> : <span />}
          <span>
            Seite {page} von {pages}
          </span>
          {page < pages ? <a href={link(page + 1)}>Weiter</a> : <span />}
        </p>
      )}
    </AdminShell>
  );
}
