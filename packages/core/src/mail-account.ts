// Mails of the customer account: login links, and the subscription's mails, which Antalyse GmbH
// sends (its name, sender and details; the invoice from its Stripe account is attached).
import type { Db } from './db.ts';
import { localePath } from './locale-paths.ts';
import { APP_NAME } from './licenses.ts';
import { formatEuro } from './money.ts';
import { cardNames, cardNameText, FINISHES } from './catalog.ts';
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
    codeSubject: (code: string) => `${code} ist dein Code für Overpriced Cardboard`,
    codeIntro: 'gib diesen Code in der App Overpriced Cardboard Scanner ein, um dich anzumelden:',
    codeValid: (m: number) => `Der Code gilt ${m} Minuten und nur ein Mal.`,
    codeIgnore:
      'Du hast das nicht angefordert? Dann ignoriere diese E-Mail. Ohne den Code kann sich niemand anmelden.',
    verifySubject: (verified: boolean) =>
      verified
        ? 'Dein Kundenkonto bei Overpriced Cardboard'
        : 'Bitte bestätige deine E-Mail-Adresse',
    verifyIntro: (verified: boolean, again: boolean) =>
      again
        ? 'mit diesem Link bestätigst du deine E-Mail-Adresse und meldest dich im Kundenkonto an.'
        : verified
          ? 'du hast in der App Overpriced Cardboard Scanner ein Konto mit dieser E-Mail-Adresse angelegt. Mit dem Button meldest du dich im Kundenkonto auf overpricedcardboard.com an, wo du deine Sammlung, deine Geräte und dein Abo siehst.'
          : 'du hast in der App Overpriced Cardboard Scanner ein Konto mit dieser E-Mail-Adresse angelegt. Bitte bestätige die Adresse mit dem Button. Damit meldest du dich auch im Kundenkonto auf overpricedcardboard.com an, wo du deine Sammlung, deine Geräte und dein Abo siehst.',
    verifyButton: (verified: boolean) =>
      verified ? 'Zum Kundenkonto' : 'E-Mail-Adresse bestätigen',
    verifyValid: (d: number) =>
      `Der Link gilt ${d} Tage und nur ein Mal. Danach meldest du dich im Konto mit deiner E-Mail-Adresse an und bekommst einen neuen Link.`,
    verifyIgnore: (verified: boolean) =>
      verified
        ? 'Du hast kein Konto angelegt? Dann schreib uns bitte kurz.'
        : 'Du hast kein Konto angelegt? Dann ignoriere diese E-Mail. Ein unbestätigtes Konto ohne Abo löschen wir nach 30 Tagen.',
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
    devicesEndedSubject: 'Deine zusätzlichen Geräte sind beendet',
    devicesEndedIntro: (store: string, devices: string) =>
      `dein Abo aus ${store} läuft nicht mehr. Deshalb haben wir auch die zusätzlichen Geräte beendet, die du im Konto dazu gebucht hattest (${devices}).`,
    devicesEndedRefund: (amount: string) =>
      `Den nicht genutzten Teil erstatten wir dir: ${amount}. Die Gutschrift hängt an dieser E-Mail; das Geld geht auf dem Weg zurück, auf dem du bezahlt hast.`,
    devicesEndedNoRefund: 'Vom letzten Zeitraum war nichts mehr zu erstatten.',
    devicesEndedAgain: (store: string) =>
      `Läuft dein Abo in ${store} wieder, kannst du die Geräte jederzeit neu dazubuchen.`,
    appleDevicesSubject: 'Deine zusätzlichen Geräte im App Store laufen weiter',
    appleDevicesNoSub: (devices: string, plan: string) =>
      `dein ${plan}-Abo aus dem App Store läuft nicht mehr. Die zusätzlichen Geräte, die du dazu im App Store gebucht hast (${devices}), verlängern sich dort aber weiter und zählen ohne das Abo nicht.`,
    appleDevicesOtherPlan: (devices: string, plan: string, current: string) =>
      `dein Abo im App Store ist jetzt ${current}. Die zusätzlichen Geräte, die du für ${plan} gebucht hast (${devices}), verlängern sich weiter, zählen für ${current} aber nicht. Für ${current} buchst du die Geräte in der App neu.`,
    appleDevicesCancel: (d: string) =>
      `Kündigen kannst nur du sie, nicht wir: auf dem iPhone unter Einstellungen → dein Name → Abos, oder unter apps.apple.com/account/subscriptions. Sonst verlängern sie sich am ${d}.`,
    appleDevicesRefund:
      'Für einen schon bezahlten Zeitraum kannst du bei Apple eine Erstattung anfragen: reportaproblem.apple.com.',
    toAppleSubscriptions: 'Abos im App Store',
    sharedSubject: (who: string) => `${who} zeigt dir eine Kartensammlung`,
    sharedIntro: (who: string) => `${who} hat eine Kartensammlung mit dir geteilt.`,
    sharedTitled: (who: string, title: string) =>
      `${who} hat die Kartensammlung „${title}“ mit dir geteilt.`,
    sharedNote: 'Nachricht:',
    sharedValid: (d: string) =>
      `Der Link funktioniert bis ${d}. Ein Konto brauchst du dafür nicht.`,
    sharedOpen: 'Sammlung ansehen',
    someone: 'Jemand',
    availableSubject: (n: number) =>
      n === 1 ? 'Eine gesuchte Karte ist jetzt im Shop' : `${n} gesuchte Karten sind jetzt im Shop`,
    availableIntro: (n: number) =>
      n === 1
        ? 'eine Karte von deiner Liste fehlender Karten ist jetzt bei uns im Shop:'
        : 'Karten von deiner Liste fehlender Karten sind jetzt bei uns im Shop:',
    availableFirst: 'Wer zuerst kauft, bekommt die Karte.',
    availableList:
      'Deine Liste bearbeitest du im Konto unter „Fehlende Karten“. Kaufst du eine Karte im Shop, kommt sie von der Liste in deine Sammlung.',
    toWanted: 'Fehlende Karten',
    view: 'Ansehen',
    offerSubject: 'Ein Angebot für deine gesuchte Karte',
    offerIntro: 'wir haben eine Karte für dich, die auf deiner Liste fehlender Karten steht:',
    offerPrice: (price: string) => `Dein Preis: <strong>${price}</strong>`,
    offerInstead: (price: string) => ` (im Shop ${price})`,
    offerValid: (d: string) => `Das Angebot gilt bis ${d}.`,
    offerHeld: 'Bis dahin halten wir die Karte für dich zurück.',
    offerOpen: 'Bis dahin kann die Karte aber auch jemand anders im Shop kaufen.',
    offerHow:
      'Im Konto unter „Fehlende Karten“ legst du sie zu deinem Preis in den Warenkorb oder lehnst das Angebot ab.',
    offerButton: 'Angebot ansehen',
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
    codeSubject: (code: string) => `${code} is your Overpriced Cardboard code`,
    codeIntro: 'enter this code in the Overpriced Cardboard Scanner app to sign in:',
    codeValid: (m: number) => `The code works for ${m} minutes and only once.`,
    codeIgnore:
      'You did not ask for this? Then ignore this e-mail. Nobody can sign in without the code.',
    verifySubject: (verified: boolean) =>
      verified ? 'Your Overpriced Cardboard account' : 'Please confirm your e-mail address',
    verifyIntro: (verified: boolean, again: boolean) =>
      again
        ? 'use this link to confirm your e-mail address and log in to your account.'
        : verified
          ? 'you created an account with this e-mail address in the Overpriced Cardboard Scanner app. The button logs you in to your account on overpricedcardboard.com, where you see your collection, your devices and your subscription.'
          : 'you created an account with this e-mail address in the Overpriced Cardboard Scanner app. Please confirm the address with the button. It also logs you in to your account on overpricedcardboard.com, where you see your collection, your devices and your subscription.',
    verifyButton: (verified: boolean) =>
      verified ? 'Open your account' : 'Confirm e-mail address',
    verifyValid: (d: number) =>
      `The link works for ${d} days and only once. After that, log in to the account with your e-mail address to get a new one.`,
    verifyIgnore: (verified: boolean) =>
      verified
        ? 'You did not create an account? Then please let us know.'
        : 'You did not create an account? Then ignore this e-mail. An unconfirmed account without a subscription is deleted after 30 days.',
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
    devicesEndedSubject: 'Your extra devices have ended',
    devicesEndedIntro: (store: string, devices: string) =>
      `your subscription from ${store} is no longer running, so we have also ended the extra devices you had added in your account (${devices}).`,
    devicesEndedRefund: (amount: string) =>
      `We refund the unused part: ${amount}. The credit note is attached to this e-mail; the money goes back the way you paid.`,
    devicesEndedNoRefund: 'Nothing was left to refund from the last period.',
    devicesEndedAgain: (store: string) =>
      `Once your subscription in ${store} runs again, you can add the devices again at any time.`,
    appleDevicesSubject: 'Your extra devices in the App Store are still renewing',
    appleDevicesNoSub: (devices: string, plan: string) =>
      `your ${plan} subscription from the App Store is no longer running. The extra devices you added to it in the App Store (${devices}) still renew there, but they don’t count without the subscription.`,
    appleDevicesOtherPlan: (devices: string, plan: string, current: string) =>
      `your App Store subscription is now ${current}. The extra devices you added for ${plan} (${devices}) still renew, but they don’t count for ${current}. Add the devices for ${current} again in the app.`,
    appleDevicesCancel: (d: string) =>
      `Only you can cancel them, not us: on your iPhone under Settings → your name → Subscriptions, or at apps.apple.com/account/subscriptions. Otherwise they renew on ${d}.`,
    appleDevicesRefund:
      'For a period you have already paid for, you can ask Apple for a refund: reportaproblem.apple.com.',
    toAppleSubscriptions: 'Subscriptions in the App Store',
    sharedSubject: (who: string) => `${who} is showing you a card collection`,
    sharedIntro: (who: string) => `${who} shared a card collection with you.`,
    sharedTitled: (who: string, title: string) =>
      `${who} shared the card collection “${title}” with you.`,
    sharedNote: 'Message:',
    sharedValid: (d: string) => `The link works until ${d}. You don’t need an account for it.`,
    sharedOpen: 'View the collection',
    someone: 'Someone',
    availableSubject: (n: number) =>
      n === 1
        ? 'A card you’re looking for is in the shop'
        : `${n} cards you’re looking for are in the shop`,
    availableIntro: (n: number) =>
      n === 1
        ? 'a card from your list of missing cards is now in our shop:'
        : 'cards from your list of missing cards are now in our shop:',
    availableFirst: 'Whoever buys first gets the card.',
    availableList:
      'You edit your list in your account under “Missing cards”. When you buy a card in the shop, it moves from the list to your collection.',
    toWanted: 'Missing cards',
    view: 'View',
    offerSubject: 'An offer for a card you’re looking for',
    offerIntro: 'we have a card for you that is on your list of missing cards:',
    offerPrice: (price: string) => `Your price: <strong>${price}</strong>`,
    offerInstead: (price: string) => ` (in the shop ${price})`,
    offerValid: (d: string) => `The offer is open until ${d}.`,
    offerHeld: 'Until then we keep the card for you.',
    offerOpen: 'Until then, someone else may still buy the card in the shop.',
    offerHow:
      'In your account under “Missing cards” you can put it in your cart at your price, or decline the offer.',
    offerButton: 'View the offer',
  },
} as const;

const accountUrl = (ctx: MailContext, locale: 'de' | 'en', de: string, en: string) =>
  ctx.baseUrl + localePath(locale, { de, en });

const day = (d: Date, locale: 'de' | 'en') =>
  new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
    dateStyle: 'long',
    timeZone: 'Europe/Vienna',
  }).format(d);

const dateTime = (d: Date, locale: 'de' | 'en') =>
  new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Vienna',
  }).format(d);

type ProductLine = {
  id: number;
  slug: string;
  slug_en: string | null;
  status: string;
  name_de: string;
  name_en: string;
  name_local: string | null;
  card_language: string;
  card_number: string;
  set_name_de: string | null;
  set_name_en: string | null;
  finish: string;
  condition: string;
  grading_company: string | null;
  grading_grade: string | null;
  price_cents: number | null;
};

async function productLines(db: Db, ids: number[]): Promise<ProductLine[]> {
  if (ids.length === 0) return [];
  return db<ProductLine[]>`
    SELECT id, slug, slug_en, status, name_de, name_en, name_local, card_language, card_number,
           set_name_de, set_name_en, finish, condition, grading_company, grading_grade, price_cents
      FROM products WHERE id = ANY(${ids}::bigint[]) ORDER BY price_cents NULLS LAST, id`;
}

/** One card in a mail: names, set, number, language, printing, condition, price, a link. */
function productRow(p: ProductLine, L: 'de' | 'en', link: string): string {
  const names = cardNames(
    {
      cardLanguage: p.card_language,
      nameDe: p.name_de,
      nameEn: p.name_en,
      nameLocal: p.name_local,
    },
    L,
  );
  const set = L === 'en' ? (p.set_name_en ?? p.set_name_de) : (p.set_name_de ?? p.set_name_en);
  const finish = FINISHES[p.finish as keyof typeof FINISHES]?.[L] ?? p.finish;
  const cond = p.grading_company ? `${p.grading_company} ${p.grading_grade}` : p.condition;
  const meta = [set, p.card_number, p.card_language, finish, cond].filter(Boolean).join(' · ');
  const price = p.status === 'active' && p.price_cents !== null ? formatEuro(p.price_cents, L) : '';
  return `<tr><td style="padding:8px 0;border-bottom:1px solid ${C.line};vertical-align:top">
<strong lang="${names.lang}">${esc(cardNameText(names))}</strong><br>
<span style="color:${C.muted};font-size:13px">${esc(meta)}</span></td>
<td style="padding:8px 0 8px 12px;border-bottom:1px solid ${C.line};text-align:right;vertical-align:top;white-space:nowrap">${link ? `${esc(price)}<br>${link}` : ''}</td></tr>`;
}

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
    case 'app_login_code': {
      const code = String(payload.code ?? '');
      if (!/^\d{6}$/.test(code)) throw new Error('not a login code');
      const subject = t.codeSubject(code);
      const body = [
        p(esc(t.hello)),
        p(esc(t.codeIntro)),
        `<p style="margin:0 0 14px;font-size:32px;font-weight:700;letter-spacing:6px;font-family:Menlo,Consolas,monospace">${code}</p>`,
        p(esc(t.codeValid(Number(payload.minutes ?? 10)))),
        `<p style="margin:0;color:${C.muted};font-size:13px">${esc(t.codeIgnore)}</p>`,
      ].join('\n');
      return { subject, html: layout(L, ctx, subject, body) };
    }
    case 'account_verify': {
      const url = String(payload.url ?? '');
      if (!url.startsWith(ctx.baseUrl)) throw new Error('verification link for another host');
      const verified = payload.verified === true;
      const subject = t.verifySubject(verified);
      const body = [
        p(esc(t.hello)),
        p(esc(t.verifyIntro(verified, payload.again === true))),
        button(url, t.verifyButton(verified)),
        p(esc(t.verifyValid(Number(payload.days ?? 7)))),
        `<p style="margin:0 0 14px;color:${C.muted};font-size:13px">${esc(t.loginFallback)}<br><a href="${esc(url)}" style="color:${C.muted};word-break:break-all">${esc(url)}</a></p>`,
        `<p style="margin:0;color:${C.muted};font-size:13px">${esc(t.verifyIgnore(verified))}</p>`,
      ].join('\n');
      return { subject, html: layout(L, ctx, subject, body) };
    }
    case 'subscription_welcome':
    case 'subscription_invoice':
    case 'subscription_payment_failed':
    case 'subscription_ended':
    case 'devices_ended': {
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
      } else if (mail.template === 'devices_ended') {
        const store = payload.store === 'app_store' ? 'App Store' : 'Google Play';
        const refund = Number(payload.refunded_cents ?? 0);
        subject = t.devicesEndedSubject;
        body = [
          p(esc(t.hello)),
          p(esc(t.devicesEndedIntro(store, t.devices(Number(payload.devices ?? 0))))),
          p(esc(refund > 0 ? t.devicesEndedRefund(formatEuro(refund, L)) : t.devicesEndedNoRefund)),
          p(esc(t.devicesEndedAgain(store))),
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
    case 'store_devices_running': {
      const plan = (k: unknown) => t.plan[String(k ?? '')] ?? String(k ?? '');
      const devices = t.devices(Number(payload.devices ?? 1));
      const subject = t.appleDevicesSubject;
      const body = [
        p(esc(t.hello)),
        p(
          esc(
            payload.reason === 'other_plan'
              ? t.appleDevicesOtherPlan(devices, plan(payload.plan), plan(payload.current_plan))
              : t.appleDevicesNoSub(devices, plan(payload.plan)),
          ),
        ),
        p(esc(t.appleDevicesCancel(day(new Date(String(payload.renews_at)), L)))),
        p(esc(t.appleDevicesRefund)),
        button('https://apps.apple.com/account/subscriptions', t.toAppleSubscriptions),
      ].join('\n');
      const g = gmbhContext(ctx);
      return {
        subject,
        html: layout(L, g, subject, body, 'app'),
        from: g.sender,
        replyTo: g.sender,
      };
    }
    case 'collection_shared': {
      const [sh] = await db<
        {
          title: string | null;
          message: string | null;
          expires_at: Date | null;
          owner_name: string | null;
          owner_email: string;
        }[]
      >`SELECT s.title, s.message, s.expires_at, a.name AS owner_name, a.email AS owner_email
          FROM collection_shares s JOIN accounts a ON a.id = s.account_id
         WHERE s.id = ${Number(payload.share_id)} AND s.revoked_at IS NULL`;
      if (!sh) throw new Error('share not found or revoked');
      const who = sh.owner_name || sh.owner_email;
      const url = String(payload.url ?? '');
      if (!url.startsWith(ctx.baseUrl)) throw new Error('share link for another host');
      const subject = t.sharedSubject(who);
      const until = sh.expires_at
        ? new Intl.DateTimeFormat(L === 'de' ? 'de-AT' : 'en-GB', {
            dateStyle: 'long',
            timeStyle: 'short',
            timeZone: 'Europe/Vienna',
          }).format(sh.expires_at)
        : '';
      const body = [
        p(esc(t.hello)),
        p(esc(sh.title ? t.sharedTitled(who, sh.title) : t.sharedIntro(who))),
        ...(sh.message
          ? [
              `<p style="margin:0 0 14px;padding:10px 14px;border-left:3px solid ${C.line};white-space:pre-wrap">${esc(sh.message)}</p>`,
            ]
          : []),
        button(url, t.sharedOpen),
        ...(until ? [p(esc(t.sharedValid(until)))] : []),
      ].join('\n');
      return { subject, html: layout(L, ctx, subject, body) };
    }
    case 'wanted_available': {
      const items = Array.isArray(payload.items)
        ? (payload.items as { product_id: number }[]).map((i) => Number(i.product_id))
        : [];
      const products = await productLines(db, [...new Set(items)]);
      if (products.length === 0) throw new Error('no products to announce');
      const subject = t.availableSubject(products.length);
      const rows = products
        .map((p) => {
          const url =
            ctx.baseUrl +
            localePath(L, { de: `/karten/${p.slug}`, en: `/cards/${p.slug_en ?? p.slug}` });
          return productRow(
            p,
            L,
            `<a href="${esc(url)}" style="color:${C.ink}">${esc(t.view)}</a>`,
          );
        })
        .join('');
      const body = [
        p(esc(t.hello)),
        p(esc(t.availableIntro(products.length))),
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;margin:0 0 14px">${rows}</table>`,
        p(esc(t.availableFirst)),
        button(accountUrl(ctx, L, '/konto/fehlend', '/account/missing'), t.toWanted),
        `<p style="margin:0;color:${C.muted};font-size:13px">${esc(t.availableList)}</p>`,
      ].join('\n');
      return { subject, html: layout(L, ctx, subject, body) };
    }
    case 'wanted_offer': {
      const [o] = await db<
        {
          product_id: number;
          price_cents: number;
          message: string | null;
          expires_at: Date;
          status: string;
        }[]
      >`SELECT product_id, price_cents, message, expires_at, status FROM wanted_offers
         WHERE id = ${Number(payload.offer_id)}`;
      if (!o || o.status !== 'open') throw new Error('offer not open');
      const [prod] = await productLines(db, [Number(o.product_id)]);
      if (!prod) throw new Error('offered product not found');
      const subject = t.offerSubject;
      const shopPrice =
        prod.status === 'active' && prod.price_cents && prod.price_cents > o.price_cents
          ? t.offerInstead(esc(formatEuro(prod.price_cents, L)))
          : '';
      const body = [
        p(esc(t.hello)),
        p(esc(t.offerIntro)),
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;margin:0 0 14px">${productRow(prod, L, '')}</table>`,
        p(t.offerPrice(esc(formatEuro(o.price_cents, L))) + shopPrice),
        ...(o.message
          ? [
              `<p style="margin:0 0 14px;padding:10px 14px;border-left:3px solid ${C.line};white-space:pre-wrap">${esc(o.message)}</p>`,
            ]
          : []),
        p(
          esc(
            `${t.offerValid(dateTime(o.expires_at, L))} ${prod.status === 'draft' ? t.offerHeld : t.offerOpen}`,
          ),
        ),
        button(accountUrl(ctx, L, '/konto/fehlend', '/account/missing'), t.offerButton),
        `<p style="margin:0;color:${C.muted};font-size:13px">${esc(t.offerHow)}</p>`,
      ].join('\n');
      return { subject, html: layout(L, ctx, subject, body) };
    }
    default:
      throw new Error(`not an account mail: ${mail.template}`);
  }
}
