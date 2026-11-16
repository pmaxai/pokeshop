# Deployment (manual)

The shop runs as three containers (migrate, web, worker) on the Exoscale vServer, behind one
Caddy container that terminates HTTPS for production and staging. Data lives in its own
database on the existing PostgreSQL server. GitHub Actions builds and publishes the image
`ghcr.io/pmaxai/pokeshop`; pulling and starting it on the server is done by hand.

```
internet ──► Caddy (infra/caddy) ──► pokeshop-web          ──► PostgreSQL: pokeshop
                                └──► pokeshop-staging-web  ──► PostgreSQL: pokeshop_staging
             worker containers ──► Stripe, Microsoft Graph, TCGdex
```

## 1. Prerequisites on the server (Debian 12)

- Docker Engine with the Compose plugin from Docker's apt repository (not Debian's `docker.io`):

  ```sh
  sudo apt update && sudo apt install -y ca-certificates curl git
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
  Types: deb
  URIs: https://download.docker.com/linux/debian
  Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
  Components: stable
  Architectures: $(dpkg --print-architecture)
  Signed-By: /etc/apt/keyrings/docker.asc
  EOF
  sudo apt update
  sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  docker compose version
  ```

- Ports 80 and 443 (TCP) and 443 (UDP, HTTP/3) open in the Exoscale security group.
- DNS: `overpricedcardboard.com`, `www.overpricedcardboard.com` and `staging.overpricedcardboard.com` point to the
  vServer (A and, if used, AAAA records). Caddy fetches certificates automatically once DNS resolves.

## 2. Databases on the PostgreSQL server

One database and one login per stack. `pg_trgm` and `unaccent` are trusted extensions, so the
database owner can create them; the first migration does that.

```sql
CREATE ROLE pokeshop LOGIN PASSWORD '…';
CREATE DATABASE pokeshop OWNER pokeshop;

CREATE ROLE pokeshop_staging LOGIN PASSWORD '…';
CREATE DATABASE pokeshop_staging OWNER pokeshop_staging;
```

Allow the vServer to connect (pg_hba.conf / Exoscale security group, port 5432 only from the
vServer). Use TLS (`DATABASE_SSL=require`) unless the connection runs over a private network.
PostgreSQL 14 or newer.

## 3. Files on the server

```
/opt/pokeshop/
  app/               git clone of this repository (only infra/ is needed at runtime)
  production.env     from .env.example, production values
  staging.env        from .env.example, staging values (Stripe test keys, staging database)
  secrets/graph-cert.pem   readable by uid 1001 (the app user in the image)
  production.image   optional: pins production to one image (see 8. Roll back)
  staging.image      optional: pins staging to one image
```

Values containing `$` must be in single quotes in every env file (Compose expands `$` otherwise).

Generate the random key per stack:

```sh
openssl rand -base64 32   # API_KEY_MASTER_KEY
```

Keep `API_KEY_MASTER_KEY` safe: without it the stored API-client secrets cannot be decrypted and
the scanning app needs new keys.

## 4. Caddy (once)

```sh
cd /opt/pokeshop/app
docker network create pokeshop-edge
cp infra/caddy/.env.example infra/caddy/.env   # set ACME_EMAIL and the staging password hash (in single quotes)
docker compose -f infra/caddy/compose.yaml up -d
```

Staging is protected with basic auth, except the Stripe webhooks, `/api/v1/*` and
`/api/store/*` (app-store notifications), which authenticate themselves. The scanner app's CI
gets through with the header `X-Staging-Access` carrying `STAGING_ACCESS` from
`infra/caddy/.env`; give the app team the same value (their GitHub secret
`ACCOUNT_STAGING_ACCESS`). After changing the Caddyfile or its `.env`:
`docker compose -f infra/caddy/compose.yaml up -d --force-recreate`.

## 5. Image tags

Each stack follows its own tag of `ghcr.io/pmaxai/pokeshop`:

| Tag                    | Moves when                                                           | Used by           |
| ---------------------- | -------------------------------------------------------------------- | ----------------- |
| `:staging`             | automatically, with every merge into `main`                          | staging           |
| `:production`          | only when someone runs **Actions → Promote to production** in GitHub | production        |
| `:production-previous` | with every promotion: the image production had before                | roll back         |
| `:sha-<commit>`        | never: one per merged commit                                         | pinning a version |

Promoting re-points `:production` at the image `:staging` runs (by digest, nothing is rebuilt),
so production gets exactly what was tested. The workflow also takes `production-previous` or a
`sha-…` tag, and has a dry-run switch. To require a second person for promotions, add required
reviewers to the `production` environment in the repository settings.

If the GHCR package is private, log in once with a GitHub token that has `read:packages`:

```sh
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

Alternatively build on the server, `docker build -f infra/Dockerfile -t pokeshop:local .`, and pin
a stack to it by writing `pokeshop:local` into `/opt/pokeshop/<stack>.image`.

## 6. Start or update a stack

`infra/stack.sh` sets the project name, settings file and image for a stack, so production and
staging cannot be mixed up (it also refuses a settings file whose `PUBLIC_BASE_URL` belongs to the
other stack). Never run `infra/compose.yaml` without it: without `-p` the project is production.

```sh
cd /opt/pokeshop/app && git pull

# only when git pull changed infra/caddy/Caddyfile: Caddy reads it only at start, and the
# container keeps seeing the old file until it is recreated
docker compose -f infra/caddy/compose.yaml up -d --force-recreate

# staging: newest image from main
infra/stack.sh staging up -d --pull always
infra/stack.sh staging version          # image, commit and start time of web

# after testing: GitHub → Actions → Promote to production → Run workflow (source: staging)
infra/stack.sh production up -d --pull always
infra/stack.sh production version       # same commit as staging
```

`migrate` runs the database migrations, loads the legal texts (terms, withdrawal, privacy) from
`packages/core/legal` and exits; `web` and `worker` start only after it succeeded. The worker
mounts `/opt/pokeshop/secrets` read-only at `/run/secrets` (other folder: `SECRETS_DIR=…`), so
`GRAPH_CLIENT_CERT_PATH=/run/secrets/graph-cert.pem` finds the mail certificate.

The worker log shows at start what it uses, e.g.
`[worker] started (payments: stripe, mail: graph)`. Without Graph settings mails stay queued in
the database and go out as soon as Graph is configured.

Check: `infra/stack.sh production ps` (web and worker healthy), `curl -fsS https://overpricedcardboard.com/api/health`.

## 7. First start

1. The worker notices the empty card master data and runs the TCGdex sync on its own (about two
   minutes; afterwards every night between 3 and 5 o'clock). Check in the admin under
   _Übersicht → Kartendaten_.
2. Sign in at `https://<host>/admin` with your Microsoft account (docs/m365-setup.md, part B).
3. Create the scanning app's key under _API-Schlüssel_ (owner only). The secret is shown once.
   Without the admin sign-in configured yet, the same works from the server:
   `infra/stack.sh production exec worker node apps/worker/src/cli.ts api-client create "Scanner Lager"`
4. Point the scanning app at `https://staging.overpricedcardboard.com/api/v1` first and send a test card;
   it appears in the staging shop and under _Produkte_.

## 8. Roll back

Production: run **Promote to production** with source `production-previous`, then
`infra/stack.sh production up -d --pull always`. Without GitHub (or for staging): pin the stack by
writing an older image into `/opt/pokeshop/<stack>.image`, e.g.
`ghcr.io/pmaxai/pokeshop:sha-abc1234`, and run `infra/stack.sh <stack> up -d --pull always`;
delete the file to follow the tag again. Migrations only ever add; a rollback of the code works
against the newer schema. A destructive schema change will be announced in the
release notes with its own steps.

## 9. Stripe

In the Stripe Dashboard – test mode for staging, live mode for production:

1. **Payment methods** (Settings → Payment methods): switch on Cards, Apple Pay, Google Pay, EPS
   and PayPal. The shop offers card (which includes Apple Pay and Google Pay), EPS and PayPal;
   `STRIPE_PAYMENT_METHODS=card,eps,paypal` changes that list.
2. **Branding** (Settings → Branding): logo, accent colour `#ef5b0c`, shop name – this is what
   buyers see on the payment page.
3. **API key**: Developers → API keys → secret key into `STRIPE_SECRET_KEY` (`sk_test_…` on
   staging, `sk_live_…` in production; a restricted key needs write access to Checkout Sessions
   and Refunds).
4. **Webhook**: Developers → Webhooks → add the endpoint `https://<host>/api/stripe/webhook`
   with the events below and put its signing secret into `STRIPE_WEBHOOK_SECRET`:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `charge.refunded`
- `charge.dispute.created`

Test on staging with Stripe's test cards (e.g. `4242 4242 4242 4242`, any future date, any CVC):
the order page shows "Danke für deine Bestellung!", the confirmation mail arrives, and in the
admin the stock is counted down. Without a Stripe key the shop refuses to take orders (except on
`localhost`, where a stand-in payment page is used for development).

### Stripe of Antalyse GmbH (app subscriptions)

The app subscriptions (Collector, Creator, extra devices) are paid to the GmbH's own Stripe
account with Stripe Billing. In that account (test mode for staging):

1. **Payment methods** and **Branding** as above (name: Antalyse GmbH / Overpriced Cardboard
   Scanner). For subscriptions Stripe offers only methods that can be charged again (cards,
   Apple Pay, Google Pay, SEPA Direct Debit, PayPal where enabled); EPS is not offered there.
2. **Stripe Tax** (Settings → Tax): origin address Wienerstraße 1, 2440 Moosbrunn; registrations
   for Austria and the EU One-Stop-Shop (union scheme), so Stripe charges the buyer's country's
   VAT to consumers. The shop creates the products and prices itself on first use (lookup keys
   `oc_collector_700_incl`, … with tax code SaaS); prices are changed in Admin › Kunden & Abos ›
   Abo-Preise, which creates new Stripe prices for new subscriptions.
3. **Invoices** (Settings → Billing → Invoices): add the UID ATU79907228 as the account's tax id
   and make it the default on invoices; choose the invoice number prefix and the PDF template.
   Leave "Email finalized invoices to customers" and "Successful payments" e-mails off: the shop
   sends the welcome mail and each invoice itself (with the PDF).
4. **Subscriptions** (Settings → Billing → Subscriptions and emails): retries for failed payments
   ("Smart Retries", e.g. 4 tries within 2 weeks), then **cancel the subscription**. The customer
   gets the shop's "payment failed" mail after each failed try.
5. **Customer portal** (Settings → Billing → Customer portal): activate it with "Update payment
   methods" and "Invoice history" on. Subscription changes and cancellation happen in the shop's
   account pages, so they can stay off in the portal.
6. **API key** into `STRIPE_LICENSE_SECRET_KEY` (a restricted key needs write access to Checkout
   Sessions, Customers, Products, Prices, Subscriptions, Subscription Items, Invoices, Credit
   Notes, Refunds, Billing Portal Sessions, **Meters and Meter Events**). The worker needs the same
   variable (one env file for all containers).
7. **Webhook** `https://<host>/api/stripe/webhook-licenses` with these events; its signing secret
   into `STRIPE_LICENSE_WEBHOOK_SECRET`:

- `checkout.session.completed`
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
- `invoice.paid`, `invoice.payment_failed`
- for the old licence orders still: `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`,
  `charge.dispute.created`

Business customers' EU VAT ids are checked live against VIES
(`ec.europa.eu/taxation_customs/vies`); the server must be able to reach it. The subscription
e-mails are sent from the GmbH's mailbox set in Admin › App: that mailbox must be in the same
Microsoft 365 tenant and inside the mail app's scope (docs/m365-setup.md, A.3).

Test on staging (card `4242 4242 4242 4242`): log in with an e-mail link, subscribe to Collector as
a private person in Austria (€ 7,00 incl. 20 % VAT), check the welcome mail with the invoice PDF,
connect a phone under Konto › Geräte, change to Creator (charged pro rata right away), cancel
(ends at the end of the month). A German business with a VAT id pays € 5,83 net (reverse charge).
Stripe's test clock (Billing → Test clocks) shows renewals and failed payments without waiting.

**Usage services** (S3 storage per GB uploaded, video pipeline per minute; Creator only): set the
prices in Admin › Kunden & Abos › Abo-Preise, switch the service on for the customer in Admin ›
Kunden › (customer) › Dienste and enter the S3 settings there. Create an API key "Für:
Video-Pipeline" in Admin › API-Schlüssel for the pipeline (scope `usage:write`; it cannot touch
products). The pipeline reports usage with `POST /api/v1/usage`; the worker passes it on to two
Stripe meters (`oc_s3_mb`, `oc_pipeline_seconds`, created by the shop on first use) and adds the
metered price to the customer's subscription the first time, so Stripe bills the month's usage
with the next invoice. Usage of a free (complimentary) subscription is recorded but not billed.

The app checks the subscription at `https://<host>/api/app/v1/…` (docs/app-account-api.md). The
old licence service (`license.<host>`) keeps answering app builds with licence keys until the app
is switched to account pairing; licences are no longer sold.

## 10. App stores (Google Play)

The store editions of the scanner app sell Collector and Creator in Google Play
(docs/app-account-api.md › Sign-in, Buying in Google Play). Set up once, in the company's
Google Cloud project and the Play Console of the app `com.overpricedcardboard.app`:

1. **Sign in with Google** – Google Cloud › APIs & Services › Credentials: an OAuth client of type
   _Web application_ (the app passes its id as server client id) plus an _Android_ client with the
   app's package name and signing certificates (SHA-1 of the upload and the Play app signing key).
   Put the web client's id into `GOOGLE_OAUTH_CLIENT_IDS` (comma-separated if there are more) and
   give it to the app team. The OAuth consent screen needs the privacy policy URL.
2. **Products** – Play Console › Monetize › Subscriptions: one subscription per plan, each with
   two auto-renewing base plans (monthly, yearly; yearly = 12 × monthly − 10 %, set per country by
   hand). Turn on the grace period. Enter the product and base plan ids in Admin › Kunden & Abos ›
   App-Stores. An id can never be reused once created.
3. **Service account for the Play Developer API** – Google Cloud › IAM: a service account with a
   JSON key; enable the _Google Play Android Developer API_ in the project. In the Play Console ›
   Users and permissions, invite the service account's e-mail with _View financial data_ and
   _Manage orders and subscriptions_ for the app. Put the key file into
   `GOOGLE_PLAY_SERVICE_ACCOUNT` (the JSON, or base64 of it, in single quotes). Web and worker
   read it.
4. **Notifications** – Google Cloud › Pub/Sub: a topic (e.g. `play-billing`) and grant
   `google-play-developer-notifications@system.gserviceaccount.com` the role _Pub/Sub Publisher_
   on it. Add a **push** subscription to `https://overpricedcardboard.com/api/store/google/notifications`
   (staging: `https://staging…/api/store/google/notifications`) with _Enable authentication_ and a
   service account of the project; leave the audience empty (= the push URL). Put that service
   account's e-mail into `GOOGLE_PUBSUB_SERVICE_ACCOUNT`. Play Console › Monetization setup: the
   topic's full name, then _Send test notification_ (the worker log shows
   `[store] Google notification: test`).
5. **Testing** – Play Console › License testing: testers buy for free and their subscriptions
   renew every few minutes. Staging with `STORE_TEST_HOOKS=1` also accepts `test_…` purchase
   tokens and test sign-ins without Google.
6. **Review account** – set `REVIEW_LOGIN_CODE` (and `REVIEW_EMAIL` if it isn't
   `review@overpricedcardboard.com`) and write e-mail and code into the review notes of the Play
   Console (App content › App access). If recordings are to be uploaded in review, give that
   account S3 settings of a separate test bucket.
7. **Store listing pages** – Play Console › App content: _Privacy policy_
   `https://overpricedcardboard.com/app/privacy`; _Data safety_ › account deletion
   `https://overpricedcardboard.com/delete-account` (the same URL for the OAuth consent screen in
   step 1). The privacy text is the legal text `app_privacy` (packages/core/legal/app_privacy.*.md),
   with Antalyse GmbH as controller; it names TCGdex for the card images and lists what the app
   sends. Have the app team confirm that list before the first release.

Deleting an account (app, portal or `/delete-account`) cancels a running website subscription at
Stripe and a Google Play one at Google (both run to the end of the paid period; the worker retries
Google every 10 minutes), signs out all devices and removes the data. The scrubbed account row is
removed after 30 days, later while a cancelled subscription still runs or usage is still to be
billed.

Data pack for the store editions: the worker mirrors the Data pipeline's release `data-pack`
into the media volume (`app-pack/`, files named by SHA-256, the last 3 versions; about 100 MB
the first time, then usually only the catalog each night) and the app downloads it through
`GET /api/app/v1/pack` with URLs that work one hour. The worker reaches github.com for it, like
the price import. When the release is made private, set `PACK_GITHUB_TOKEN` (fine-grained,
_Contents: read_ on `pmaxai/TCGdex`) for the worker; both the price import and the mirror use it.

What the server does: every report from the app and every notification reads the subscription
from Google again and stores it (Admin › Kunden › customer › Käufe in den App-Stores); the
worker re-reads every subscription that runs out within 2 days twice a day. A purchase on an
account that already has a paid subscription is not acknowledged, so Google refunds it after 3
days. Usage services (S3, pipeline) are billed through Stripe and are not billed for store
subscribers.

## 11. Backups and restore test

The vServer (including the `media` volume with product images) and the PostgreSQL server are
covered by the existing backups. Once a quarter, restore the latest `pokeshop` dump into a
scratch database and start a staging stack against it.
