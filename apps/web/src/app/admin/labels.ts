export const STATUS_LABELS: Record<string, string> = {
  checkout: 'Zahlung läuft',
  awaiting_payment: 'Zahlung ausstehend',
  paid: 'Bezahlt – zu packen',
  packing: 'Wird gepackt',
  shipped: 'Versendet',
  completed: 'Abgeschlossen',
  expired: 'Reservierung abgelaufen',
  payment_failed: 'Zahlung fehlgeschlagen',
  cancelled: 'Abgebrochen',
  refunded: 'Erstattet',
};

export const SHIPPING_LABELS: Record<string, string> = {
  standard: 'Standard',
  insured: 'Versichert',
  tracked: 'Nachverfolgt (ohne Versicherung)',
  none: 'Kein Versand (Gutschein)',
};

export const EVENT_LABELS: Record<string, string> = {
  created: 'Bestellung angelegt, Karten reserviert',
  payment_started: 'Zahlungsseite geöffnet',
  paid: 'Bezahlt',
  expired: 'Reservierung abgelaufen',
  cancelled: 'Abgebrochen',
  payment_failed: 'Zahlung fehlgeschlagen',
  replaced_by_new_checkout: 'Durch neuen Kassenversuch ersetzt',
  sold_out_after_payment: 'Zahlung kam zu spät, Karten verkauft',
  refunded: 'Erstattet',
  refund_failed: 'Erstattung fehlgeschlagen',
  refunded_in_stripe: 'Im Stripe-Dashboard erstattet',
  packing: 'Packliste gedruckt',
  shipped: 'Versendet',
  note: 'Notiz geändert',
  withdrawal_received: 'Widerruf eingegangen',
  dispute_opened: 'Zahlung angefochten',
  licenses_issued: 'Lizenzschlüssel erstellt und verschickt',
  license_mail_resent: 'Lizenz-E-Mail erneut gesendet',
  licenses_revoked: 'Lizenzen gesperrt',
  vouchers_gone_after_payment: 'Zahlung kam zu spät, Gutschein schon verbraucht',
};

/** Where a voucher came from: the disclosure for the books. */
export const VOUCHER_ORIGIN: Record<string, string> = {
  sold: 'Verkauft (bezahlt)',
  promo: 'Geschenkt (ohne Einnahme)',
};

export const VOUCHER_STATUS: Record<string, string> = {
  active: 'Aktiv',
  blocked: 'Gesperrt',
  cancelled: 'Storniert',
};

export const VOUCHER_MOVEMENT: Record<string, string> = {
  issued: 'Ausgestellt',
  redeemed: 'Eingelöst',
  released: 'Zurück (Bestellung nicht bezahlt)',
  restored: 'Zurückgebucht (Erstattung)',
  cancelled: 'Storniert',
};

export const MAIL_LABELS: Record<string, string> = {
  order_confirmation: 'Bestellbestätigung',
  order_notification: 'Bestellhinweis an den Shop',
  order_unavailable: 'Karten vergriffen, erstattet',
  order_shipped: 'Versandbestätigung mit Rechnung',
  refund_issued: 'Erstattung',
  withdrawal_ack: 'Widerruf: Eingangsbestätigung',
  withdrawal_notification: 'Widerruf: Hinweis an den Shop',
  admin_alert: 'Hinweis',
  license_delivery: 'App-Lizenz mit Rechnung',
  license_resend: 'App-Lizenz erneut angefordert',
  voucher_purchase: 'Gutschein mit PDF',
  wanted_available: 'Gesuchte Karte im Shop',
  wanted_offer: 'Angebot für eine gesuchte Karte',
};

export const dateTime = (d: Date | string | null | undefined) =>
  d
    ? new Intl.DateTimeFormat('de-AT', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: 'Europe/Vienna',
      }).format(new Date(d))
    : '–';

/** Value for <input type="datetime-local"> in Vienna time. */
export const localInput = (d: Date | string | null | undefined) => {
  if (!d) return '';
  const parts = new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/Vienna',
  }).format(new Date(d));
  return parts.replace(' ', 'T');
};

/** States of an app-store purchase in the admin's words. */
export const STORE_STATE: Record<string, string> = {
  pending: 'Zahlung ausstehend',
  active: 'Aktiv',
  canceled: 'Aktiv',
  grace: 'Zahlung offen (Kulanzzeit)',
  past_due: 'Zahlung offen (Kulanzzeit)',
  on_hold: 'Zahlung fehlgeschlagen, gesperrt',
  paused: 'Pausiert',
  expired: 'Beendet',
  revoked: 'Erstattet',
};

/** Status of a customer's subscription in the admin's words. */
export function subscriptionStatusLabel(r: {
  source: string | null;
  status: string | null;
  cancelAtPeriodEnd: boolean;
  endsAt: Date | null;
}) {
  if (!r.status) return '–';
  if (r.source === 'google_play' || r.source === 'app_store') {
    const store = r.source === 'google_play' ? 'Google Play' : 'App Store';
    const s = STORE_STATE[r.status] ?? r.status;
    const running = ['active', 'canceled', 'past_due', 'grace'].includes(r.status);
    return `${s} (${store})${running && r.cancelAtPeriodEnd ? ', gekündigt' : ''}`;
  }
  if (r.source === 'complimentary') {
    return r.endsAt && r.endsAt <= new Date() ? 'Gratis, abgelaufen' : 'Gratis';
  }
  const map: Record<string, string> = {
    active: 'Aktiv',
    trialing: 'Aktiv',
    past_due: 'Zahlung offen',
    canceled: 'Beendet',
    unpaid: 'Unbezahlt',
    incomplete: 'Zahlung läuft',
    incomplete_expired: 'Nicht zustande gekommen',
    paused: 'Pausiert',
  };
  const s = map[r.status] ?? r.status;
  return r.cancelAtPeriodEnd && r.status !== 'canceled' ? `${s}, gekündigt` : s;
}
