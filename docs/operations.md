# Daily work in the admin

Sign in at `https://overpricedcardboard.com/admin` with your Microsoft account. Staff can pack, ship and
handle withdrawals; refunds and settings need the owner role.

## Packing and shipping

1. **Bestellungen → Zu packen** lists paid orders, oldest payment first. Untick any you do not
   want to pack now and click **Packliste für die markierten drucken**.
2. The pick list has one line per box and card, sorted by box number, so you walk the boxes once.
   After it come one packing slip per order with the address and, in capitals, **VERSICHERT
   VERSENDEN** for insured parcels. Print it (the admin bar is not printed).
3. Pack each order, then open it and click **Als versendet markieren**. Insured and tracked
   parcels need the Post tracking number; standard letters do not.
4. The shop then issues the invoice and e-mails the customer the shipping confirmation with the
   invoice and the tracking link.

Cards with a price above € 50 make the parcel insured; above € 500 order value the parcel goes
tracked but uninsured. The order list shows "Versichert" in bold.

## Refunds (owner)

Open the order, choose how many copies of each card to refund, tick **wieder verkaufen** to put
them back into the box they came from, optionally refund the shipping charge, confirm and click
**Erstatten**. Stripe pays the money back to the customer's payment method; the customer gets an
e-mail, with a correction document (Rechnungskorrektur) if the order was already invoiced.

- **Cancel before shipping:** refund all cards (and the shipping charge). No invoice is issued.
- **Damaged card before shipping:** refund just that card; the invoice at shipping bills only
  what is in the parcel.
- **Withdrawal:** refund once the cards are back (or the customer shows the return receipt). On a
  full withdrawal the shipping charge must be refunded too.

Refund only in the admin, not in the Stripe Dashboard: Dashboard refunds are recorded, but cards
are not put back and no correction document is made.

## Withdrawals

**Widerrufe** lists every declaration sent through "Vertrag widerrufen". The customer already got
the acknowledgement with date and time. Check the order, refund when the cards are back, then
click **Erledigt** (with a note if useful).

## Events

**Veranstaltungen → Neue Veranstaltung**: title, start (and end), place, optional entry fee, your
stand and a description. Tick **Im Shop veröffentlichen** to show it on `/veranstaltungen`. Past
events move to the "Vergangene Veranstaltungen" list by themselves.

## Settings (owner)

**Einstellungen** holds the delivery countries (on/off, minimum order, insurance rate, minimum and
limit, delivery time), the high-value limit, the reservation time, who receives shop e-mails and
the Post tracking link. Check the tracking link once with a real tracking number; `{number}` is
replaced by it.
