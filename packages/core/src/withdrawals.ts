// Online withdrawal ("Vertrag widerrufen", § 13a FAGG): the form asks only for what the law
// allows (name, contract identification, where the acknowledgement goes). No reason is asked,
// unknown order numbers are accepted – eligibility is checked by staff afterwards.
import { z } from 'zod';
import type { Sql } from './db.ts';
import { enqueueMail, enqueueShopMail } from './outbox.ts';
import { orderEvent } from './orders.ts';

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'too_long')
    .transform((v) => v || undefined)
    .optional();

export const WithdrawalForm = z.object({
  name: z.string().trim().min(1, 'required').max(120, 'too_long'),
  email: z.email('invalid_email').trim().toLowerCase().max(200, 'too_long'),
  order_number: z
    .string()
    .trim()
    .max(40, 'too_long')
    .transform((v) => v.toUpperCase().replace(/\s+/g, '') || undefined)
    .optional(),
  order_date: optional(40),
  items: optional(2000),
  message: optional(4000),
});
export type WithdrawalForm = z.infer<typeof WithdrawalForm>;

export function validateWithdrawal(
  input: unknown,
): { ok: true; data: WithdrawalForm } | { ok: false; errors: Record<string, string> } {
  const r = WithdrawalForm.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  const errors: Record<string, string> = {};
  for (const i of r.error.issues) errors[i.path.join('.') || '_'] ??= i.message;
  return { ok: false, errors };
}

/**
 * Stores the declaration with its time of receipt and queues the acknowledgement
 * (content + date and time of receipt, on a durable medium) and the shop's notice.
 */
export async function recordWithdrawal(
  sql: Sql,
  form: WithdrawalForm,
  locale: 'de' | 'en',
): Promise<{ id: number; receivedAt: Date }> {
  return sql.begin(async (tx) => {
    const [order] = form.order_number
      ? await tx<{ id: number }[]>`SELECT id FROM orders WHERE number = ${form.order_number}`
      : [];
    const [w] = await tx<{ id: number; received_at: Date }[]>`
      INSERT INTO withdrawals (order_id, order_number, name, email, items, order_date, message, locale)
      VALUES (${order?.id ?? null}, ${form.order_number ?? null}, ${form.name}, ${form.email},
              ${form.items ?? null}, ${form.order_date ?? null}, ${form.message ?? null}, ${locale})
      RETURNING id, received_at`;
    await enqueueMail(tx, {
      template: 'withdrawal_ack',
      to: form.email,
      locale,
      payload: { withdrawal_id: w!.id },
      dedupeKey: `withdrawal_ack:${w!.id}`,
    });
    await enqueueShopMail(
      tx,
      'withdrawal_notification',
      { withdrawal_id: w!.id },
      `withdrawal_notification:${w!.id}`,
    );
    if (order) await orderEvent(tx, order.id, 'withdrawal_received', { withdrawal_id: w!.id });
    return { id: w!.id, receivedAt: w!.received_at };
  });
}
