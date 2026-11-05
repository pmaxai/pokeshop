import { notFound } from 'next/navigation';
import { getEvent, type ShopEvent } from '@pokeshop/core/events';
import { db } from '@/server/config';
import { requireAdmin } from '@/server/admin-auth';
import { AdminShell } from '../../AdminShell';
import { deleteEventAction, saveEventAction } from '../../order-actions';
import { localInput } from '../../labels';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Veranstaltung' };

export default async function EventEdit({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const raw = (await params).id;
  let e: Partial<ShopEvent> = { country: 'AT', status: 'draft' };
  if (raw !== 'neu') {
    const found = Number.isSafeInteger(Number(raw)) ? await getEvent(db(), Number(raw)) : null;
    if (!found) notFound();
    e = found;
  }
  const field = (
    name: keyof ShopEvent,
    label: string,
    opts: { type?: string; required?: boolean; area?: boolean; hint?: string; value?: string } = {},
  ) => (
    <label className="field">
      <span>
        {label}
        {opts.required ? ' *' : ''}
      </span>
      {opts.area ? (
        <textarea name={name} defaultValue={String(e[name] ?? '')} rows={6} />
      ) : (
        <input
          name={name}
          type={opts.type ?? 'text'}
          defaultValue={opts.value ?? String(e[name] ?? '')}
          required={opts.required}
        />
      )}
      {opts.hint && <small className="muted">{opts.hint}</small>}
    </label>
  );
  return (
    <AdminShell user={user} active="events" notice={await searchParams}>
      <p>
        <a href="/admin/veranstaltungen">Veranstaltungen</a>
      </p>
      <h1>{e.id ? e.title_de : 'Neue Veranstaltung'}</h1>
      <form action={saveEventAction} className="stack-admin">
        {e.id && <input type="hidden" name="id" value={e.id} />}
        <div className="form-grid">
          {field('title_de', 'Titel', { required: true })}
          {field('title_en', 'Titel englisch', { hint: 'leer = deutscher Titel' })}
          {field('starts_at', 'Beginn', {
            type: 'datetime-local',
            required: true,
            value: localInput(e.starts_at),
          })}
          {field('ends_at', 'Ende', { type: 'datetime-local', value: localInput(e.ends_at) })}
          {field('venue', 'Ort / Halle')}
          {field('street', 'Straße')}
          {field('postcode', 'PLZ')}
          {field('city', 'Stadt', { required: true })}
          {field('country', 'Land (AT, DE …)', { required: true })}
          {field('entry_fee', 'Eintritt', { hint: 'z. B. 5 €, Kinder frei' })}
          {field('table_info', 'Unser Stand / Tische', { hint: 'z. B. Tisch 14, Halle B' })}
          {field('website_url', 'Webseite', { type: 'url' })}
        </div>
        {field('description_de', 'Beschreibung', { area: true })}
        {field('description_en', 'Beschreibung englisch', {
          area: true,
          hint: 'leer = deutscher Text',
        })}
        <label className="check">
          <input
            type="checkbox"
            name="status"
            value="published"
            defaultChecked={e.status === 'published'}
          />{' '}
          Im Shop veröffentlichen
        </label>
        <p>
          <button className="btn btn--accent" type="submit">
            Speichern
          </button>
        </p>
      </form>
      {e.id && (
        <form action={deleteEventAction} className="stack-admin danger">
          <input type="hidden" name="id" value={e.id} />
          <h2>Löschen</h2>
          <label className="check">
            <input type="checkbox" name="confirm" required /> Diese Veranstaltung endgültig löschen
          </label>
          <p>
            <button className="btn btn--quiet" type="submit">
              Löschen
            </button>
          </p>
        </form>
      )}
    </AdminShell>
  );
}
