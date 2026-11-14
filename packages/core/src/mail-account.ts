// Mails of the customer account (login links; later subscription, offers, missing cards).
import type { Db } from './db.ts';
import { button, C, esc, layout, p, type MailContext, type Rendered } from './mail.ts';
import type { OutboxMail } from './outbox.ts';

const TEXT = {
  de: {
    loginSubject: 'Dein Login-Link für Overpriced Cardboard',
    loginIntro: (created: boolean) =>
      created
        ? 'mit diesem Link meldest du dich an, dein Kundenkonto wird dabei angelegt.'
        : 'mit diesem Link meldest du dich in deinem Kundenkonto an.',
    loginValid: (m: number) => `Der Link gilt ${m} Minuten und nur ein Mal.`,
    loginButton: 'Anmelden',
    loginFallback: 'Falls der Button nicht geht, kopiere diese Adresse in den Browser:',
    loginIgnore:
      'Du hast das nicht angefordert? Dann ignoriere diese E-Mail. Ohne Klick auf den Link passiert nichts.',
    hello: 'Hallo,',
  },
  en: {
    loginSubject: 'Your login link for Overpriced Cardboard',
    loginIntro: (created: boolean) =>
      created
        ? 'use this link to log in; it also creates your customer account.'
        : 'use this link to log in to your customer account.',
    loginValid: (m: number) => `The link works for ${m} minutes and only once.`,
    loginButton: 'Log in',
    loginFallback: 'If the button does not work, copy this address into your browser:',
    loginIgnore:
      'You did not ask for this? Then ignore this e-mail. Nothing happens unless the link is opened.',
    hello: 'Hello,',
  },
} as const;

export async function renderAccountMail(
  _db: Db,
  mail: OutboxMail,
  ctx: MailContext,
): Promise<Rendered> {
  const L = mail.locale;
  const t = TEXT[L];
  const payload = mail.payload as Record<string, unknown>;
  switch (mail.template) {
    case 'account_login': {
      const url = String(payload.url ?? '');
      if (!url.startsWith(ctx.baseUrl)) throw new Error('login link for another host');
      const body = [
        p(esc(t.hello)),
        p(esc(t.loginIntro(payload.new_account === true))),
        button(url, t.loginButton),
        p(esc(t.loginValid(Number(payload.minutes ?? 20)))),
        `<p style="margin:0 0 14px;color:${C.muted};font-size:13px">${esc(t.loginFallback)}<br><a href="${esc(url)}" style="color:${C.muted};word-break:break-all">${esc(url)}</a></p>`,
        `<p style="margin:0;color:${C.muted};font-size:13px">${esc(t.loginIgnore)}</p>`,
      ].join('\n');
      return { subject: t.loginSubject, html: layout(L, ctx, t.loginSubject, body) };
    }
    default:
      throw new Error(`not an account mail: ${mail.template}`);
  }
}
