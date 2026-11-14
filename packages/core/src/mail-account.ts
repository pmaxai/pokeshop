// Mails of the customer account: login links, and the subscription's mails, which Antalyse GmbH
// sends (its name, sender and details; the invoice from its Stripe account is attached).
import type { Db } from './db.ts';
import { localePath } from './locale-paths.ts';
import { APP_NAME } from './licenses.ts';
import { formatEuro } from './money.ts';
import {
  button,
  C,
  esc,
  gmbhContext,
  h2,
  layout,
  p,
  type MailContext,
  type Rendered,
} from './mail.ts';
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
    plan: { collector: 'Collector', creator: 'Creator' } as Record<string, string>,
    devices: (n: number) => (n === 1 ? '1 Gerät' : `${n} Geräte`),
    welcomeSubject: `Dein Abo für den ${APP_NAME}`,
    welcomeIntro: (plan: string, devices: string) =>
      `danke für dein Abo! Du hast jetzt <strong>${plan}</strong> für ${devices}. Die Rechnung hängt an dieser E-Mail.`,
    nextTitle: 'So geht es weiter',
    nextInstall:
      'Installiere die App auf deinem Android-Handy (Download in deinem Konto unter „Geräte“).',
    nextConnect:
      'Öffne in deinem Konto „Geräte“ → „Gerät verbinden“ und scanne den QR-Code mit der App. Ein Passwort brauchst du nicht.',
    nextPortal:
      'Im Konto findest du auch deine Sammlung mit aktuellen Preisen und deine fehlenden Karten.',
    toDevices: 'Gerät verbinden',
    invoiceSubject: (n: string) => `Deine Rechnung ${n} für den ${APP_NAME}`,
    invoiceIntro: (total: string) =>
      `hier ist deine Rechnung über ${total} für dein Abo. Sie hängt als PDF an dieser E-Mail.`,
    toAccount: 'Zum Konto',
    failedSubject: 'Zahlung für dein Abo fehlgeschlagen',
    failedIntro: 'die Zahlung für dein Abo hat nicht geklappt.',
    failedRetry: (d: string) =>
      `Stripe versucht es am ${d} noch einmal. Bitte prüfe vorher deine Zahlungsart.`,
    failedLast: 'Bitte prüfe deine Zahlungsart, sonst endet das Abo.',
    failedHow: 'Unter „Abo“ in deinem Konto führt „Zahlungsart und Rechnungen“ zu Stripe.',
    endedSubject: 'Dein Abo ist beendet',
    endedIntro:
      'dein Abo für den Overpriced Cardboard Scanner ist beendet. Die App ist gesperrt, deine Sammlung bleibt gespeichert.',
    endedAgain: 'Du kannst jederzeit wieder ein Abo abschließen; deine Geräte bleiben verbunden.',
    toSubscription: 'Abo abschließen',
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
    plan: { collector: 'Collector', creator: 'Creator' } as Record<string, string>,
    devices: (n: number) => (n === 1 ? '1 device' : `${n} devices`),
    welcomeSubject: `Your ${APP_NAME} subscription`,
    welcomeIntro: (plan: string, devices: string) =>
      `thank you for subscribing! You now have <strong>${plan}</strong> for ${devices}. The invoice is attached to this e-mail.`,
    nextTitle: 'What’s next',
    nextInstall:
      'Install the app on your Android phone (download in your account under “Devices”).',
    nextConnect:
      'In your account, open “Devices” → “Connect a device” and scan the QR code with the app. No password needed.',
    nextPortal: 'Your account also has your collection with current prices and your missing cards.',
    toDevices: 'Connect a device',
    invoiceSubject: (n: string) => `Your invoice ${n} for the ${APP_NAME}`,
    invoiceIntro: (total: string) =>
      `here is your invoice for ${total} for your subscription. It is attached as a PDF.`,
    toAccount: 'Open your account',
    failedSubject: 'Payment for your subscription failed',
    failedIntro: 'the payment for your subscription did not go through.',
    failedRetry: (d: string) =>
      `Stripe will try again on ${d}. Please check your payment method before then.`,
    failedLast: 'Please check your payment method, or the subscription ends.',
    failedHow:
      'In your account, “Subscription” → “Payment method and invoices” takes you to Stripe.',
    endedSubject: 'Your subscription has ended',
    endedIntro:
      'your Overpriced Cardboard Scanner subscription has ended. The app is locked; your collection stays saved.',
    endedAgain: 'You can subscribe again any time; your devices stay connected.',
    toSubscription: 'Subscribe',
  },
} as const;

const accountUrl = (ctx: MailContext, locale: 'de' | 'en', de: string, en: string) =>
  ctx.baseUrl + localePath(locale, { de, en });

const day = (d: Date, locale: 'de' | 'en') =>
  new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
    dateStyle: 'long',
    timeZone: 'Europe/Vienna',
  }).format(d);

export async function renderAccountMail(
  db: Db,
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
    case 'subscription_welcome':
    case 'subscription_invoice':
    case 'subscription_payment_failed':
    case 'subscription_ended': {
      const g = gmbhContext(ctx);
      const [sub] = await db<{ plan: string; extra_devices: number }[]>`
        SELECT plan, extra_devices FROM subscriptions WHERE account_id = ${Number(payload.account_id)}`;
      const plan = t.plan[sub?.plan ?? String(payload.plan ?? '')] ?? '';
      let subject: string;
      let body: string[];
      if (mail.template === 'subscription_welcome') {
        subject = t.welcomeSubject;
        body = [
          p(esc(t.hello)),
          p(t.welcomeIntro(esc(plan), esc(t.devices(1 + (sub?.extra_devices ?? 0))))),
          h2(t.nextTitle),
          `<ol style="margin:0 0 14px;padding-left:20px">${[
            t.nextInstall,
            t.nextConnect,
            t.nextPortal,
          ]
            .map((x) => `<li style="margin:0 0 6px">${esc(x)}</li>`)
            .join('')}</ol>`,
          button(accountUrl(ctx, L, '/konto/geraete', '/account/devices'), t.toDevices),
        ];
      } else if (mail.template === 'subscription_invoice') {
        subject = t.invoiceSubject(String(payload.number ?? ''));
        body = [
          p(esc(t.hello)),
          p(esc(t.invoiceIntro(formatEuro(Number(payload.total ?? 0), L)))),
          button(accountUrl(ctx, L, '/konto/abo', '/account/subscription'), t.toAccount),
        ];
      } else if (mail.template === 'subscription_payment_failed') {
        subject = t.failedSubject;
        const next = payload.next_attempt ? new Date(String(payload.next_attempt)) : null;
        body = [
          p(esc(t.hello)),
          p(esc(t.failedIntro)),
          p(esc(next ? t.failedRetry(day(next, L)) : t.failedLast)),
          p(esc(t.failedHow)),
          button(accountUrl(ctx, L, '/konto/abo', '/account/subscription'), t.toAccount),
        ];
      } else {
        subject = t.endedSubject;
        body = [
          p(esc(t.hello)),
          p(esc(t.endedIntro)),
          p(esc(t.endedAgain)),
          button(accountUrl(ctx, L, '/konto/abo', '/account/subscription'), t.toSubscription),
        ];
      }
      return {
        subject,
        html: layout(L, g, subject, body.join('\n'), 'app'),
        from: g.sender,
        replyTo: g.sender,
      };
    }
    default:
      throw new Error(`not an account mail: ${mail.template}`);
  }
}
