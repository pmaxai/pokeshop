// Mail outbox: every e-mail is written here in the same transaction as the change that
// causes it, and the worker sends it through Microsoft Graph (mail.ts).
import type { Db } from './db.ts';

export type MailTemplate =
  | 'order_confirmation'
  | 'order_notification'
  | 'order_unavailable'
  | 'withdrawal_ack'
  | 'withdrawal_notification'
  | 'admin_alert';

export type MailAttachment =
  { kind: 'document'; id: number } | { kind: 'legal'; kinds: ('agb' | 'withdrawal' | 'privacy')[] };

export type OutboxMail = {
  id: number;
  template: MailTemplate;
  to_address: string;
  reply_to: string | null;
  locale: 'de' | 'en';
  payload: Record<string, unknown>;
  attachments: MailAttachment[];
  attempts: number;
};

export async function enqueueMail(
  db: Db,
  mail: {
    template: MailTemplate;
    to: string;
    locale: 'de' | 'en';
    payload?: Record<string, unknown>;
    attachments?: MailAttachment[];
    replyTo?: string | null;
    /** Same key → the mail is queued only once (e.g. order_confirmation:123). */
    dedupeKey?: string;
  },
): Promise<number | null> {
  const [r] = await db<{ id: number }[]>`
    INSERT INTO outbox (template, dedupe_key, to_address, reply_to, locale, payload, attachments)
    VALUES (${mail.template}, ${mail.dedupeKey ?? null}, ${mail.to}, ${mail.replyTo ?? null},
            ${mail.locale}, ${db.json((mail.payload ?? {}) as never)},
            ${db.json((mail.attachments ?? []) as never)})
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id`;
  return r?.id ?? null;
}

/** Mail to the shop's own recipients (setting admin_alert_recipients). */
export async function enqueueShopMail(
  db: Db,
  template: Extract<MailTemplate, 'order_notification' | 'withdrawal_notification' | 'admin_alert'>,
  payload: Record<string, unknown>,
  dedupeKey?: string,
): Promise<void> {
  const [s] = await db<{ value: unknown }[]>`
    SELECT value FROM settings WHERE key = 'admin_alert_recipients'`;
  const to = Array.isArray(s?.value) ? (s.value as string[]) : [];
  for (const addr of to) {
    await enqueueMail(db, {
      template,
      to: addr,
      locale: 'de',
      payload,
      dedupeKey: dedupeKey ? `${dedupeKey}:${addr}` : undefined,
    });
  }
}

export async function alertShop(
  db: Db,
  subject: string,
  text: string,
  dedupeKey?: string,
): Promise<void> {
  await enqueueShopMail(db, 'admin_alert', { subject, text }, dedupeKey);
}

/** Next due mail, marked as sending; stale "sending" rows (crash) become due again. */
export async function claimMail(db: Db): Promise<OutboxMail | null> {
  await db`UPDATE outbox SET status = 'pending'
            WHERE status = 'sending' AND next_attempt_at < now() - interval '10 minutes'`;
  const [m] = await db<OutboxMail[]>`
    UPDATE outbox SET status = 'sending', attempts = attempts + 1, next_attempt_at = now()
     WHERE id = (SELECT id FROM outbox WHERE status = 'pending' AND next_attempt_at <= now()
                  ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, template, to_address, reply_to, locale, payload, attachments, attempts`;
  return m ?? null;
}

export async function markMailSent(db: Db, id: number): Promise<void> {
  await db`UPDATE outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = ${id}`;
}

/** Retries with growing pauses (1, 4, 9 … minutes), gives up after 8 attempts. */
export async function markMailFailed(db: Db, mail: OutboxMail, error: string): Promise<boolean> {
  const final = mail.attempts >= 8;
  await db`
    UPDATE outbox SET status = ${final ? 'failed' : 'pending'}, last_error = ${error.slice(0, 2000)},
           next_attempt_at = now() + make_interval(mins => ${mail.attempts * mail.attempts})
     WHERE id = ${mail.id}`;
  return final;
}
