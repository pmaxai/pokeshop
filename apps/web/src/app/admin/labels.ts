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
  none: 'Kein Versand (App-Lizenz)',
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
