import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import {
  ChallengeUsed,
  contactCounts,
  deleteOldContactMessages,
  listContactMessages,
  openContactMessage,
  recordContactMessage,
  setContactDone,
  setContactNotify,
} from '../../src/contact.ts';
import { sendDueMails, type Mail, type MailTransport } from '../../src/mail.ts';

let sql: Sql;
let drop: () => Promise<void>;

before(async () => {
  ({ sql, drop } = await freshDatabase());
});
after(async () => drop());

class Memory implements MailTransport {
  readonly name = 'memory';
  sent: Mail[] = [];
  async send(m: Mail) {
    this.sent.push(m);
  }
}
const ctx = {
  baseUrl: 'https://overpricedcardboard.com',
  mediaDir: '/tmp',
  company: { name: 'Overpriced Cardboard', public_name: 'Overpriced Cardboard' },
  replyTo: 'order@overpricedcardboard.com',
};
const form = (message: string) => ({
  name: 'Misty',
  email: 'misty@example.com',
  subject: 'Glurak gesucht',
  message,
});

test('a message is stored, mailed to the shop with reply-to the sender, and only once', async () => {
  const id = await recordContactMessage(sql, form('Habt ihr Glurak 4/102?'), 'de', 'salt-1');
  const [m] = await listContactMessages(sql, 'open');
  assert.equal(m!.id, id);
  assert.equal(m!.read_at, null);
  assert.deepEqual(await contactCounts(sql), { unread: 1, open: 1 });

  const t = new Memory();
  await sendDueMails(sql, t, ctx, 10);
  const mail = t.sent.find((x) => x.subject.startsWith('Neue Nachricht'))!;
  assert.equal(mail.subject, 'Neue Nachricht von Misty: Glurak gesucht');
  assert.equal(mail.to, 'order@overpricedcardboard.com');
  assert.equal(mail.replyTo, 'misty@example.com');
  assert.match(mail.html, /Habt ihr Glurak 4\/102\?/);
  assert.match(mail.html, new RegExp(`/admin/nachrichten/${id}`));

  await assert.rejects(
    recordContactMessage(sql, form('noch einmal'), 'de', 'salt-1'),
    ChallengeUsed,
    'a solved challenge sends one message',
  );
});

test('with the switch off, messages arrive only in the admin', async () => {
  await setContactNotify(sql, false);
  await recordContactMessage(sql, form('Ohne Mail'), 'en', 'salt-2');
  const [n] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM outbox WHERE template = 'contact_notification'`;
  assert.equal(n!.n, 1, 'still only the first message was mailed');
  await setContactNotify(sql, true);
});

test('opening marks read, done moves it out of the open list, old handled ones go', async () => {
  const [m] = await listContactMessages(sql, 'open');
  const opened = await openContactMessage(sql, m!.id);
  assert.ok(opened?.read_at);
  await setContactDone(sql, m!.id, true, 'brock@example.com');
  assert.ok(!(await listContactMessages(sql, 'open')).some((x) => x.id === m!.id));
  assert.equal((await listContactMessages(sql, 'done'))[0]!.done_by, 'brock@example.com');
  assert.equal(await deleteOldContactMessages(sql), 0, 'recently handled ones stay');
  await sql`UPDATE contact_messages SET done_at = now() - interval '400 days' WHERE id = ${m!.id}`;
  assert.equal(await deleteOldContactMessages(sql), 1);
  assert.equal((await listContactMessages(sql, 'all')).length, 1);
});
