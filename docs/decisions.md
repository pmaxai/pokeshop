# Technical decisions

Short records of choices that shape the code. Newest first.

## 2026-11-12 · Contact form with a proof of work instead of a captcha service

The contact page (`/contact`, `/de/kontakt`) stores messages in `contact_messages`; they are read
and handled in Admin › Nachrichten. Spam is kept out without a third party and without cookies:
a hidden honeypot field (filled → "sent", nothing stored), a signed challenge per page view that
must be at least 3 seconds and at most 2 hours old, a proof of work the browser solves when the
visitor ticks "I am human" (SHA-256 with 15 leading zero bits, well under a second on a desktop),
each challenge usable once (unique column), and at most 5 messages per IP address in 15 minutes,
counted only in the web process's memory. The challenge key is derived from `API_KEY_MASTER_KEY`.

A switch on the messages page (setting `contact_notify`, on by default) sends each new message
to the admin alert recipients, with the sender as reply-to. Handled messages are deleted after
twelve months by the worker, as the privacy policy says.

## 2026-11-12 · The app is called Overpriced Cardboard Scanner

ScanPM is renamed to "Overpriced Cardboard Scanner" (`APP_NAME`) everywhere a buyer sees it: app
page, footer, licence mails, invoice lines, licence terms and the other legal texts; the beta is
called "Android-Beta". German texts avoid compounds with the long name ("Lizenz für …"). The app
page also presents two services of Antalyse GmbH, Automatic Content Processing (for YouTube-mode
recordings) and Webshop as a Service; enquiries go to the GmbH's mailbox.

## 2026-11-12 · English first, delivery to the whole EU

English is the default language at the domain root; German moved under /de with its translated
paths (`/de/karten`, `/de/warenkorb`). Links built outside the web app (mails, legal texts) use
`localePath` in core, which mirrors the routing. Old German root links redirect permanently to
/de (the language proxy, apps/web/src/proxy.ts, derived from the routing table). No automatic redirect by browser language.

All 27 EU countries are delivery countries. Migration 0016 gave the new ones Germany's terms
(free standard shipping, € 20 minimum order, same insurance rules) and 4–10 working days; each
country stays editable in the admin. The VAT setting is unchanged: under the small business
scheme every order is VAT-free, which holds only while EU distance sales stay within € 10,000 a
year; above that the destination country's VAT applies and the code needs OSS next to the
small business scheme.

Every indexable page has a canonical link and hreflang alternates with English as x-default
(`pageAlternates`); the sitemap lists English URLs first. Card pages describe shipping per
country group, the 14-day return policy and the seller in schema.org; the home page names the
site and the shop. Pages without their own picture share /og.png.

## 2026-11-12 · The shop is Overpriced Cardboard at overpricedcardboard.com

The shop moved from pokemonkarten.at to overpricedcardboard.com before the first order, with no
redirect from the old domain. The name shown in the shop, mails, PDFs and invoices is "Overpriced
Cardboard" (as on the YouTube channel); the domain appears where an address is meant. The shop
mailbox is the new shared mailbox `order@overpricedcardboard.com`. Migration 0015 moves the stored
settings that still held the old values; the switch itself is a runbook outside the repo (DNS,
Microsoft 365, Stripe webhooks, Entra redirect URIs, a new APK with the licence server address).

## 2026-11-11 · Licences are sold in the EU only

Private persons and businesses alike must live or be established in the EU
(`licenseCountryAllowed`); the form offers EU countries only and the server refuses others. The
business countries outside the EU (CH, LI, NO, IS, GB, US, CA, AU) are gone, and with them
their tax id formats and the `export` regime for licences. Tax ids are EU VAT ids only, checked
with VIES. Older orders may still carry `export`; the database keeps the value.

## 2026-11-10 · Sold vouchers are money, promotional vouchers and codes are discounts

There are two kinds of voucher, told apart by `vouchers.origin`, and they are booked differently:

- **Sold** (`'sold'`): a customer bought it on `/gutscheine`, as an order of kind `'voucher'`.
  It is a multi-purpose voucher: no VAT and no invoice at the sale, only a receipt; the open
  balance is money the shop owes. When it is redeemed it pays part of a card order
  (`orders.voucher_cents`); the order's invoice is unchanged by it and lists the voucher under
  the total as a payment (`documents.payments`).
- **Promotional** (`'promo'`): created in the admin without income, optionally with an expiry
  date. When redeemed it lowers the price like a discount code (`orders.discount_cents`, a
  negative line on the invoice), so the VAT is worked out on the reduced price.

Discount codes (`discount_codes`) are percent or a fixed amount, for cards, licences or both,
with optional minimum order, use limit, once per customer, validity dates and batches of
single-use codes (`PREFIX-XXXXXX`). One code and up to five vouchers fit on an order; sold
vouchers apply last, after the price is final. Vouchers only pay for cards, never licences
(those belong to the GmbH, see below).

Amounts are taken from vouchers when the order is created (`voucher_redemptions`, status
`held`), not at payment, so two orders cannot spend the same balance. A trigger on `orders`
gives held amounts back whenever an order closes without payment (expired, payment failed,
cancelled) and marks them `used` on payment; a payment that still arrives for a closed order
takes them again. Stripe gets the reduction as a one-off coupon on the session, so only what is
left is charged; an order that is fully covered skips Stripe. A remainder below Stripe's minimum
of €0.50 is avoided by using a little less of the last voucher.

Every change to a balance writes `voucher_movements` (issued, redeemed, released, restored,
cancelled) with the origin, so the bookkeeping CSV in the admin separates money received and
spent from discounts given away. Refunds of a card order are split proportionally between the
voucher part (back onto the voucher) and the card or bank part.

## 2026-11-09 · Licences are sold by Antalyse GmbH through its own Stripe account

Cards are sold by the sole trader, app licences by Antalyse GmbH. Each order has a `seller`
('shop' or 'gmbh'), and each seller has its own Stripe account (`STRIPE_*` and
`STRIPE_LICENSE_*`) with its own webhook (`/api/stripe/webhook`, `/api/stripe/webhook-licenses`).
A provider only completes, expires or refunds orders of its own seller, so a misrouted event
cannot touch the other company's orders.

The GmbH's VAT is worked out by Stripe Tax, not by the shop: every licence purchase creates a
Stripe customer with billing address and tax id, the session runs with `automatic_tax`, and
Stripe issues invoice and credit note (`invoice_creation`, `creditNotes.create` with every line,
so the VAT is reversed). The shop keeps no invoice numbers for the GmbH; it stores Stripe's
number and links and attaches Stripe's PDFs to its own e-mails. The paid session's total, tax
and rate replace the estimate on the order.

Prices: the set price includes Austrian VAT. Consumers (EU only) and Austrian businesses pay it
(Stripe Tax applies Austrian or OSS VAT). Businesses elsewhere in the EU with a VAT id that VIES
confirms (until 2026-11-11 also businesses in CH, LI, NO, IS, GB, US, CA and AU), pay the
price without Austrian VAT, as an exclusive net price on a customer with `tax_exempt = reverse`.
A VAT id VIES cannot confirm right now is not taken on trust: the form asks to try again or to
buy with VAT. Licence mails come from the GmbH's mailbox (`license_seller.email`), with its
details in the footer and its licence terms (`license_terms`) instead of the shop's AGB.

## 2026-11-09 · App licences are sold as orders of their own kind

ScanPM licences are bought on `/app` through their own short checkout (name, e-mail, EU country,
number of licences, consent to immediate delivery), not through the card cart. The purchase is
a row in `orders` with `kind = 'license'` and the quantity in `order_licenses`, so Stripe,
webhooks, invoice numbers, refunds and the admin order list work as for cards. After payment the
worker job `license.issue` gets the keys from the licence service (idempotent per order number),
issues the invoice and mails key, QR code and download link. Keys stay only in the licence
service; the mail asks for them when it is rendered. A full refund (admin or Stripe dashboard)
queues `license.revoke`. The APK is uploaded in the admin and served from MEDIA_DIR through the
order's secret link; once `app_play_store_url` is set, page, mails and that link point to the
Play Store instead. The consent to immediate delivery (§ 18 Abs. 1 Z 11 FAGG) is stored on the
order and confirmed in the licence mail.

## 2026-11-08 · Scanner-app licences: own service, one active device, offline never blocks

Licences for the scanner app come from `apps/license`, a small container next to web and worker
with its own database, so licence checks don't depend on the shop's deploys and the shop's data
stays separate. A licence is one-off and permanent; it is active on one device at a time
(a partial unique index enforces it). Activating it elsewhere suspends the old device, which
learns that on its next online check; offline the app keeps working. A suspended device comes
back only by scanning a QR code again. Keys are stored encrypted so the shop can send them again
to a customer who lost the device. The shop talks to the service only inside the stack (bearer
token); Caddy exposes just `/health`, `/v1/activate` and `/v1/check`. See
[license-service.md](license-service.md).

## 2026-11-06 · Image tags per stack: staging follows main, production is promoted

The server runs `ghcr.io/pmaxai/pokeshop:staging` and `:production` instead of a tag written
into a file for each update. CI moves `:staging` with every merge into `main`; `:production`
moves only through the manual "Promote to production" workflow, which re-points it by digest at
the image staging runs and keeps the old one as `:production-previous`. `infra/stack.sh <stack>
version` shows which commit runs; `/opt/pokeshop/<stack>.image` still pins a stack to one image.

## 2026-11-05 · Refunds go through the shop, documents never change

Refunds are made in the admin (owner role): chosen cards and optionally the shipping charge,
refunded through Stripe with the refund's id as idempotency key, then the copies go back into the
box they came from if wanted. If the order was already invoiced, a correction document
(GS-YYYY-000001, "Rechnungskorrektur") refers to the invoice. Invoices and corrections store a
frozen copy of their lines, so later changes never alter an issued document. Refunds made directly
in the Stripe Dashboard are recorded from the webhook and reported to the shop, but nothing is
restocked automatically.

## 2026-11-05 · Pick list sorted by box

The pick list combines all selected orders, one line per box and card, sorted by box number, with
one packing slip per order (address, shipping method in capitals when insured). Printing it moves
the orders to "packing". Insured and tracked parcels can only be marked shipped with a tracking
number.

## 2026-11-07 · Sole trader under the small business scheme; name only in the legal notice

The shop is run by Maximilian Pinter (sole trader, "Handel mit Waren aller Art"; since migration
0012 without the addition "Sammelkartenverkauf") under the Kleinunternehmerregelung (§ 6 Abs. 1 Z 27 UStG). The setting `small_business`
makes every order VAT-free (regime `small_business`); invoices and credit notes carry the note
"Umsatzsteuerbefreit, Kleinunternehmer gemäß § 6 Abs. 1 Z 27 UStG" instead of a VAT breakdown, and
show no UID. Switching it off brings back domestic/OSS/export VAT.

The owner's name appears on the legal notice, on invoices and credit notes (§ 11 UStG) and in the
e-mail footer (the order confirmation must identify the seller). Shop pages and the legal texts
say "Overpriced Cardboard" (`company.public_name`) with its address and refer to the legal notice.

The online withdrawal is labelled "Bestellung retournieren (Vertrag widerrufen)": the statutory
words stay in the label (§ 13a FAGG, § 356a BGB), and the confirm button keeps "Widerruf
bestätigen".

## 2026-11-05 · High value means a price above the threshold, kept by the database

A trigger sets `products.high_value` from the price (more than the setting
`high_value_threshold_cents`, € 50 since 2026-11-07, € 20 before) and re-evaluates all products
when the setting changes. The scanning app's `high_value` field is accepted but ignored, with a
warning. Insured shipping costs 5 % of the goods value (10 % before 2026-11-07), at least € 5, up
to € 500 order value; above that there is no insured option and the order ships free with
tracking.

## 2026-11-05 · Invoice when the order ships, not at payment

An invoice must state the delivery date (§ 11 UStG), which is only known when the parcel leaves.
The order confirmation therefore carries the order details, the terms and the withdrawal
instructions (PDF, § 7 FAGG); the invoice (gap-free number RE-YYYY-000001, PDF) is issued and
mailed with the shipping confirmation (admin shipping step, M3).

## 2026-11-05 · Payment: Stripe Checkout behind one interface

The shop talks to a small `PaymentProvider` interface. Production uses Stripe Checkout (card with
Apple Pay and Google Pay, EPS, PayPal); development and tests use a stand-in that only works on
localhost. The webhook re-reads the session from Stripe, so duplicate or out-of-order events do no
harm. The worker closes payment pages whose 10-minute hold ran out (plus one minute of grace).
A payment that still arrives later is accepted if the cards are free, otherwise refunded in full
automatically and the buyer is told.

## 2026-11-05 · Legal texts in the repository, versioned in the database

Terms, withdrawal instructions and privacy policy are Markdown files in `packages/core/legal`
(German binding, English translation). `migrate` stores each changed file as a new version;
orders record the versions the buyer accepted. Placeholders such as `{{company.address}}` are
filled from the company settings. The online withdrawal function (§ 13a FAGG, in force since
1 October 2026) asks only for name, contract identification and e-mail and confirms receipt with
date and time.

## 2026-11-05 · Card pictures served from our own server

TCGdex sample images and set logos are fetched by the shop and cached under `MEDIA_DIR/card-cache`
(`/media/card/…`). Visitors' browsers never contact a third party, so no consent is needed. If
TCGdex is unreachable a neutral card back is shown. Own scans are resized by the worker to WebP and
AVIF in 320/640/1200 px.

## 2026-11-05 · Admin sign-in with Microsoft Entra ID (OpenID Connect)

Authorization code flow with PKCE (`arctic`); only members of the owner/staff groups or holders of
the app roles get in. Sessions are random tokens in an HttpOnly cookie scoped to `/admin`; the
database stores only their SHA-256 hash. Admin changes go through Next.js server actions (origin
checked) and are written to the audit log.

## 2026-11-05 · Storefront: one typeface, the toploader as the one visual device

Archivo (variable width) self-hosted: expanded heavy for headings, condensed for card numbers.
Every card is shown at card proportions in a "toploader" frame; everything around it stays plain.
Filters are a GET form, so they work without JavaScript and every filtered view has a URL.

## 2026-11-05 · Scanned cards without master data

Intake fetches missing card details from TCGdex on the spot (rarity, type, names). If TCGdex is down
or does not know the card, the product is created from the names the app sends; the worker fills in
details later.

## 2026-11-05 · Deployment is manual

CI builds and publishes `ghcr.io/pmaxai/pokeshop`; the owner pulls and starts it on the
vServer (docs/deploy.md). No SSH deploy keys in GitHub.

## 2026-11-05 · Database on the existing PostgreSQL server

No database container. Production and staging each get a database and login on the existing,
already backed-up PostgreSQL server. The stack contains migrate, web and worker; Caddy runs
once per server and serves both stacks.

## 2026-11-05 · SQL-first migrations, stock rules inside PostgreSQL

Migrations are plain, numbered `.sql` files in `packages/core/migrations`, applied in order and
recorded in `schema_migrations`. Every stock movement goes through PL/pgSQL functions
(`stock_change`, `stock_set`, `stock_move`, `order_reserve`, `order_release_stock`,
`order_commit_stock`, `order_item_restock`):

- row locks are taken in one fixed order, so two buyers racing for the last copy cannot both
  get it (covered by the race test in `scripts/db-test.sh`);
- every movement writes the stock ledger in the same statement;
- the scanning-app API, the admin and the worker cannot bypass the rules, whichever code path
  calls them.

The application talks to PostgreSQL with the `postgres` driver and typed query functions
instead of an ORM. This replaces Drizzle from the concept: the schema relies on functions,
generated columns and partial indexes that an ORM schema file would only mirror.

## 2026-11-05 · Stock per storage box

Quantity is kept per (product, storage box). Reservations and sales are allocated to boxes,
lowest box number first; committed allocations print as pick-sheet lines, so a card split over
two boxes shows two lines.

## 2026-11-05 · TypeScript without a build step for core and worker

`packages/core` and the worker run as `.ts` directly on Node's type stripping (erasable syntax
only, `.ts` import extensions). Only the Next.js app has a build step.

## 2026-11-05 · Mail permission scoped in Exchange, not in Entra

The mail app gets no tenant-wide Graph `Mail.Send` grant; Exchange RBAC for Applications limits
it to `order@overpricedcardboard.com` (docs/m365-setup.md).
