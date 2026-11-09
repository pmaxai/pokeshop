# Technical decisions

Short records of choices that shape the code. Newest first.

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

The shop is run by Maximilian Pinter Sammelkartenverkauf (sole trader, "Handel mit Waren aller
Art") under the Kleinunternehmerregelung (§ 6 Abs. 1 Z 27 UStG). The setting `small_business`
makes every order VAT-free (regime `small_business`); invoices and credit notes carry the note
"Umsatzsteuerbefreit, Kleinunternehmer gemäß § 6 Abs. 1 Z 27 UStG" instead of a VAT breakdown, and
show no UID. Switching it off brings back domestic/OSS/export VAT.

The owner's name appears on the legal notice, on invoices and credit notes (§ 11 UStG) and in the
e-mail footer (the order confirmation must identify the seller). Shop pages and the legal texts
say "pokemonkarten.at" (`company.public_name`) with its address and refer to the legal notice.

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
it to `bestellung@pokemonkarten.at` (docs/m365-setup.md).
