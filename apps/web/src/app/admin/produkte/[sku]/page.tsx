import { notFound } from 'next/navigation';
import { formatEuro } from '@pokeshop/core';
import { rowNames, translationText } from '@pokeshop/core/catalog';
import { getProduct } from '@pokeshop/core/products';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../../AdminShell';
import { changeStockAction, retryImage, saveProduct } from '../../actions';

export const dynamic = 'force-dynamic';

const time = (d: Date) =>
  new Intl.DateTimeFormat('de-AT', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Vienna',
  }).format(new Date(d));
const SOURCES: Record<string, string> = {
  api: 'Scanner-App',
  admin: 'Admin',
  order: 'Bestellung',
  refund: 'Erstattung',
  sweeper: 'System',
  import: 'Import',
};

export async function generateMetadata({ params }: { params: Promise<{ sku: string }> }) {
  return { title: decodeURIComponent((await params).sku) };
}

export default async function ProductEdit({
  params,
  searchParams,
}: {
  params: Promise<{ sku: string }>;
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const sku = decodeURIComponent((await params).sku);
  const sp = await searchParams;
  const p = await getProduct(db(), sku);
  if (!p) notFound();
  const [row] = await db()<
    {
      id: number;
      description_de: string | null;
      description_en: string | null;
      slug: string;
      purchase_price_cents: number | null;
    }[]
  >`
    SELECT id, description_de, description_en, slug, purchase_price_cents FROM products WHERE sku = ${sku}`;
  const [ledger, images] = await Promise.all([
    db()<
      {
        storage_location: string;
        delta: number;
        quantity_after: number;
        source: string;
        actor: string | null;
        reference: string | null;
        reason: string | null;
        created_at: Date;
      }[]
    >`
      SELECT storage_location, delta, quantity_after, source, actor, reference, reason, created_at
        FROM stock_ledger WHERE product_id = ${row!.id} ORDER BY id DESC LIMIT 50`,
    db()<
      {
        id: number;
        role: string;
        status: string;
        source_url: string | null;
        storage_key: string | null;
        error: string | null;
      }[]
    >`
      SELECT id, role, status, source_url, storage_key, error FROM product_images WHERE product_id = ${row!.id} ORDER BY position, id`,
  ]);
  const price = p.price ? (p.price.amount / 100).toFixed(2).replace('.', ',') : '';
  const names = rowNames(p, 'de');

  return (
    <AdminShell user={user} active="products" notice={sp}>
      <p className="muted">
        <a href="/admin/produkte">Produkte</a> / {p.sku}
      </p>
      <h1>
        <span lang={names.lang}>{names.original}</span>{' '}
        {names.translations.length > 0 && (
          <span>· {names.translations.map(translationText).join(' · ')} </span>
        )}
        <span className="muted">
          {p.set_name_de ?? p.set_code} {p.card_number}
        </span>
      </h1>
      <p>
        {p.card_language}, {p.condition}, {p.finish}
        {p.grading ? `, ${p.grading.company} ${p.grading.grade}` : ''}.{' '}
        {p.status === 'active' ? (
          <a href={`/karten/${row!.slug}`} target="_blank" rel="noreferrer">
            Im Shop ansehen
          </a>
        ) : (
          <span className="pill pill--draft">nicht im Shop</span>
        )}
      </p>

      <h2>Bestand nach Box</h2>
      {p.stock.boxes.length === 0 ? (
        <p className="muted">Keine Karten auf Lager.</p>
      ) : (
        <div className="table-wrap" style={{ maxWidth: '32rem' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Box</th>
                <th className="r">Bestand</th>
                <th className="r">Reserviert</th>
                <th className="r">Verfügbar</th>
              </tr>
            </thead>
            <tbody>
              {p.stock.boxes.map((b) => (
                <tr key={b.storage_location}>
                  <td>
                    <strong>{b.storage_location}</strong>
                  </td>
                  <td className="r">{b.quantity}</td>
                  <td className="r">{b.reserved}</td>
                  <td className="r">{Math.max(0, b.quantity - b.reserved)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form action={changeStockAction} className="toolbar" style={{ marginTop: 'var(--s-4)' }}>
        <input type="hidden" name="sku" value={p.sku} />
        <label className="field">
          <span>Änderung</span>
          <select name="mode" defaultValue="add">
            <option value="add">Karten hinzufügen</option>
            <option value="remove">Karten entfernen</option>
            <option value="set">Bestand setzen (Zählung)</option>
            <option value="move">In andere Box verschieben</option>
          </select>
        </label>
        <label className="field">
          <span>Anzahl</span>
          <input
            name="qty"
            type="number"
            min={0}
            defaultValue={1}
            required
            style={{ width: '6rem' }}
          />
        </label>
        <label className="field">
          <span>Box</span>
          <input
            name="box"
            placeholder="014"
            inputMode="numeric"
            pattern="[0-9]{3,10}"
            style={{ width: '6rem' }}
          />
        </label>
        <label className="field">
          <span>Von Box</span>
          <input
            name="from"
            placeholder="nur beim Verschieben"
            inputMode="numeric"
            pattern="[0-9]{3,10}"
            style={{ width: '9rem' }}
          />
        </label>
        <label className="field">
          <span>Nach Box</span>
          <input
            name="to"
            placeholder="nur beim Verschieben"
            inputMode="numeric"
            pattern="[0-9]{3,10}"
            style={{ width: '9rem' }}
          />
        </label>
        <label className="field">
          <span>Grund</span>
          <input name="reason" placeholder="z. B. beschädigt" />
        </label>
        <button className="btn" type="submit">
          Bestand ändern
        </button>
      </form>

      <h2>Angaben</h2>
      <form action={saveProduct} className="form-grid">
        <input type="hidden" name="sku" value={p.sku} />
        <label className="field">
          <span>Name (Deutsch)</span>
          <input name="name_de" defaultValue={p.name_de} required />
        </label>
        <label className="field">
          <span>Name (Englisch)</span>
          <input name="name_en" defaultValue={p.name_en} required />
        </label>
        {!['DE', 'EN'].includes(p.card_language) && (
          <label className="field">
            <span>Name auf der Karte ({p.card_language})</span>
            <input
              name="name_local"
              defaultValue={p.name_local ?? ''}
              lang={names.lang}
              placeholder={
                p.card_language === 'JA' ? 'z. B. リザードンex' : 'wie auf der Karte gedruckt'
              }
            />
          </label>
        )}
        <label className="field">
          <span>Preis in € (inkl. USt.)</span>
          <input name="price" defaultValue={price} inputMode="decimal" placeholder="z. B. 129,00" />
        </label>
        <label className="field">
          <span>Status</span>
          <select name="status" defaultValue={p.status}>
            <option value="active">aktiv (im Shop)</option>
            <option value="draft">Entwurf</option>
            <option value="archived">archiviert</option>
          </select>
        </label>
        <span className="muted">
          {p.high_value
            ? 'Wertvolle Karte (über 20 €): versicherter Versand'
            : 'Keine wertvolle Karte (bis 20 €)'}
        </span>
        <span className="muted">
          Einkaufspreis:{' '}
          {row!.purchase_price_cents === null ? '–' : formatEuro(row!.purchase_price_cents)} (nur
          intern)
        </span>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          <span>Beschreibung (Deutsch)</span>
          <textarea
            name="description_de"
            defaultValue={row!.description_de ?? ''}
            placeholder="z. B. leicht dezentriert, kleine weiße Stelle hinten links"
          />
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          <span>Beschreibung (Englisch)</span>
          <textarea name="description_en" defaultValue={row!.description_en ?? ''} />
        </label>
        <div>
          <button className="btn btn--accent" type="submit">
            Speichern
          </button>
        </div>
      </form>

      <h2>Bilder</h2>
      {images.length === 0 ? (
        <p className="muted">
          Keine eigenen Bilder. Im Shop erscheint das Beispielbild aus den Kartendaten.
        </p>
      ) : (
        <div className="toolbar">
          {images.map((i) => (
            <figure key={i.id} style={{ margin: 0, width: '9rem' }}>
              {i.storage_key ? (
                <img
                  src={`/media/${i.storage_key}-320.webp`}
                  alt={i.role}
                  width={144}
                  height={200}
                />
              ) : (
                <div className="card-back" style={{ aspectRatio: '63/88' }}>
                  {i.status === 'pending' ? 'wird verarbeitet' : 'Fehler'}
                </div>
              )}
              <figcaption className="muted">
                {i.role},{' '}
                {i.status === 'ready'
                  ? 'bereit'
                  : i.status === 'pending'
                    ? 'in Arbeit'
                    : `Fehler: ${i.error ?? ''}`}
              </figcaption>
              {i.status === 'failed' && (
                <form action={retryImage}>
                  <input type="hidden" name="sku" value={p.sku} />
                  <input type="hidden" name="image" value={i.id} />
                  <button className="btn btn--quiet" type="submit">
                    Erneut versuchen
                  </button>
                </form>
              )}
            </figure>
          ))}
        </div>
      )}

      <h2>Bestandsverlauf</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Zeit</th>
              <th>Box</th>
              <th className="r">Änderung</th>
              <th className="r">Danach</th>
              <th>Quelle</th>
              <th>Wer</th>
              <th>Grund / Bezug</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((l, i) => (
              <tr key={i}>
                <td>{time(l.created_at)}</td>
                <td>{l.storage_location}</td>
                <td className="r">{l.delta > 0 ? `+${l.delta}` : l.delta}</td>
                <td className="r">{l.quantity_after}</td>
                <td>{SOURCES[l.source] ?? l.source}</td>
                <td>{l.actor ?? '–'}</td>
                <td>{[l.reason, l.reference].filter(Boolean).join(', ') || '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
