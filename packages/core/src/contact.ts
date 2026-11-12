// Contact form: messages from the shop's contact page land in the admin (Admin › Nachrichten),
// optionally with an e-mail to the admin alert recipients. Spam is kept out without any third
// party: a hidden honeypot field, a minimum time on the page, a small proof of work the browser
// solves when the visitor ticks "I am human", and a per-address rate limit in the web app.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Db, Sql } from './db.ts';
import { enqueueShopMail } from './outbox.ts';

export const ContactForm = z.object({
  name: z.string().trim().min(1, 'required').max(120, 'too_long'),
  // Trimmed before the check, so a stray space from copy and paste does not count as an error.
  email: z.string().trim().toLowerCase().max(200, 'too_long').pipe(z.email('invalid_email')),
  subject: z
    .string()
    .trim()
    .max(200, 'too_long')
    .transform((v) => v || undefined)
    .optional(),
  message: z.string().trim().min(1, 'required').max(5000, 'too_long'),
});
export type ContactForm = z.infer<typeof ContactForm>;

export function validateContact(
  input: unknown,
): { ok: true; data: ContactForm } | { ok: false; errors: Record<string, string> } {
  const r = ContactForm.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  const errors: Record<string, string> = {};
  for (const i of r.error.issues) errors[i.path.join('.') || '_'] ??= i.message;
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Human check: proof of work
// ---------------------------------------------------------------------------

/**
 * Leading zero bits the browser must find in SHA-256(salt:nonce): about 2^15 hashes on average,
 * a second or two on a phone, but a real cost for anyone sending thousands of messages.
 */
export const CONTACT_DIFFICULTY = 15;
/** Sooner than this after the page was served, no person has typed a message. */
export const CONTACT_MIN_SECONDS = 3;
/** A challenge older than this is refused; the visitor ticks the box again. */
export const CONTACT_MAX_SECONDS = 2 * 3600;

export type ChallengeProblem = 'missing' | 'invalid' | 'too_fast' | 'expired' | 'unsolved';

const challengeKey = (masterKey: Buffer) =>
  createHmac('sha256', masterKey).update('contact-form-challenge').digest();

const sign = (key: Buffer, body: string) =>
  createHmac('sha256', key).update(body).digest('base64url');

/** A signed challenge for one page view: "salt.issuedAt.difficulty.signature". */
export function createChallenge(
  masterKey: Buffer,
  now = new Date(),
  difficulty = CONTACT_DIFFICULTY,
): string {
  const body = `${randomBytes(16).toString('hex')}.${Math.floor(now.getTime() / 1000)}.${difficulty}`;
  return `${body}.${sign(challengeKey(masterKey), body)}`;
}

/** Leading zero bits of a SHA-256 digest. */
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** What the browser hashes; the same function is written out in the HumanCheck component. */
export const powInput = (salt: string, nonce: string | number) => `${salt}:${nonce}`;

/** Finds a nonce the way the browser does (tests and tools). */
export function solveChallenge(token: string): string {
  const [salt, , difficulty] = token.split('.');
  for (let n = 0; ; n++) {
    const d = createHash('sha256').update(powInput(salt!, n)).digest();
    if (leadingZeroBits(d) >= Number(difficulty)) return String(n);
  }
}

/** Checks signature, age and work. Returns the salt, which may be used only once. */
export function verifyChallenge(
  masterKey: Buffer,
  token: string,
  nonce: string,
  now = new Date(),
): { ok: true; salt: string } | { ok: false; problem: ChallengeProblem } {
  if (!token) return { ok: false, problem: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 4) return { ok: false, problem: 'invalid' };
  const [salt, issued, difficulty, sig] = parts as [string, string, string, string];
  const expected = Buffer.from(sign(challengeKey(masterKey), `${salt}.${issued}.${difficulty}`));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, problem: 'invalid' };
  }
  const age = now.getTime() / 1000 - Number(issued);
  if (age < CONTACT_MIN_SECONDS) return { ok: false, problem: 'too_fast' };
  if (age > CONTACT_MAX_SECONDS) return { ok: false, problem: 'expired' };
  if (!/^\d{1,12}$/.test(nonce)) return { ok: false, problem: 'unsolved' };
  const digest = createHash('sha256').update(powInput(salt, nonce)).digest();
  if (leadingZeroBits(digest) < Number(difficulty)) return { ok: false, problem: 'unsolved' };
  return { ok: true, salt };
}

// ---------------------------------------------------------------------------
// Storing and notifying
// ---------------------------------------------------------------------------

export class ChallengeUsed extends Error {}

/**
 * Stores the message and, when the switch is on, mails the admin alert recipients. A challenge
 * that already sent a message is refused (ChallengeUsed).
 */
export async function recordContactMessage(
  sql: Sql,
  form: ContactForm,
  locale: 'de' | 'en',
  challenge: string,
): Promise<number> {
  return sql.begin(async (tx) => {
    const [m] = await tx<{ id: number }[]>`
      INSERT INTO contact_messages (name, email, subject, message, locale, challenge)
      VALUES (${form.name}, ${form.email}, ${form.subject ?? null}, ${form.message}, ${locale},
              ${challenge})
      ON CONFLICT (challenge) DO NOTHING
      RETURNING id`;
    if (!m) throw new ChallengeUsed();
    if (await contactNotify(tx)) {
      await enqueueShopMail(tx, 'contact_notification', { message_id: Number(m.id) });
    }
    return Number(m.id);
  });
}

export async function contactNotify(db: Db): Promise<boolean> {
  const [s] = await db<
    { value: unknown }[]
  >`SELECT value FROM settings WHERE key = 'contact_notify'`;
  return s?.value !== false;
}

export async function setContactNotify(db: Db, on: boolean): Promise<void> {
  await db`
    INSERT INTO settings (key, value) VALUES ('contact_notify', ${db.json(on)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export type ContactMessage = {
  id: number;
  name: string;
  email: string;
  subject: string | null;
  message: string;
  locale: 'de' | 'en';
  created_at: Date;
  read_at: Date | null;
  done_at: Date | null;
  done_by: string | null;
};

export type ContactView = 'open' | 'done' | 'all';

export async function listContactMessages(
  db: Db,
  view: ContactView,
  limit = 200,
): Promise<ContactMessage[]> {
  const where =
    view === 'open'
      ? db`WHERE done_at IS NULL`
      : view === 'done'
        ? db`WHERE done_at IS NOT NULL`
        : db``;
  const rows = await db<ContactMessage[]>`
    SELECT id, name, email, subject, message, locale, created_at, read_at, done_at, done_by
      FROM contact_messages ${where} ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function contactCounts(db: Db): Promise<{ unread: number; open: number }> {
  const [c] = await db<{ unread: number; open: number }[]>`
    SELECT count(*) FILTER (WHERE read_at IS NULL AND done_at IS NULL)::int AS unread,
           count(*) FILTER (WHERE done_at IS NULL)::int AS open
      FROM contact_messages`;
  return c ?? { unread: 0, open: 0 };
}

/** One message; opening it in the admin marks it as read. */
export async function openContactMessage(db: Db, id: number): Promise<ContactMessage | null> {
  const [m] = await db<ContactMessage[]>`
    UPDATE contact_messages SET read_at = coalesce(read_at, now()) WHERE id = ${id}
    RETURNING id, name, email, subject, message, locale, created_at, read_at, done_at, done_by`;
  return m ? { ...m, id: Number(m.id) } : null;
}

export async function setContactDone(db: Db, id: number, done: boolean, by: string): Promise<void> {
  if (done) {
    await db`
      UPDATE contact_messages
         SET done_at = now(), done_by = ${by}, read_at = coalesce(read_at, now())
       WHERE id = ${id}`;
  } else {
    await db`UPDATE contact_messages SET done_at = NULL, done_by = NULL WHERE id = ${id}`;
  }
}

export async function markContactUnread(db: Db, id: number): Promise<void> {
  await db`UPDATE contact_messages SET read_at = NULL WHERE id = ${id} AND done_at IS NULL`;
}

export async function deleteContactMessage(db: Db, id: number): Promise<void> {
  await db`DELETE FROM contact_messages WHERE id = ${id}`;
}

/** Handled messages are kept for a year, then deleted (worker; see the privacy policy). */
export const CONTACT_RETENTION_DAYS = 365;

export async function deleteOldContactMessages(db: Db): Promise<number> {
  const r = await db`
    DELETE FROM contact_messages
     WHERE done_at < now() - make_interval(days => ${CONTACT_RETENTION_DAYS})`;
  return r.count;
}
