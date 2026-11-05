// Loads the legal texts from packages/core/legal into the database (migrate script only;
// kept apart from legal.ts so the web bundle never touches the file system).
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './db.ts';
import { LEGAL_KINDS, type LegalKind, type LegalLocale } from './legal.ts';

export const LEGAL_DIR = fileURLToPath(new URL('../legal/', import.meta.url));

/** Loads every `<kind>.<locale>.md`; a file whose content changed becomes a new version. */
export async function syncLegalTexts(
  sql: Sql,
  dir = LEGAL_DIR,
  log: (m: string) => void = () => {},
): Promise<number> {
  let added = 0;
  const files = (await readdir(dir)).filter((f) => /^[a-z_]+\.(de|en)\.md$/.test(f)).sort();
  for (const f of files) {
    const [kind, locale] = f.split('.') as [LegalKind, LegalLocale];
    if (!(LEGAL_KINDS as readonly string[]).includes(kind)) continue;
    const text = (await readFile(join(dir, f), 'utf8')).replace(/\r\n/g, '\n').trim() + '\n';
    const hash = createHash('sha256').update(text).digest('hex');
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? kind;
    const body = text.replace(/^#\s+.+\n+/, '');
    const inserted = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('legal_texts'))`;
      const [cur] = await tx<{ version: number; content_hash: string | null }[]>`
        SELECT version, content_hash FROM legal_texts WHERE kind = ${kind} AND locale = ${locale}
         ORDER BY version DESC LIMIT 1`;
      if (cur?.content_hash === hash) return false;
      await tx`
        INSERT INTO legal_texts (kind, locale, version, title, body_md, published_at, created_by, content_hash)
        VALUES (${kind}, ${locale}, ${(cur?.version ?? 0) + 1}, ${title}, ${body}, now(), 'repository', ${hash})`;
      return true;
    });
    if (inserted) {
      added++;
      log(`legal text ${f}: new version`);
    }
  }
  return added;
}
