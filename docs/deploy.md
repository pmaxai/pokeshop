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
- DNS: `pokemonkarten.at`, `www.pokemonkarten.at` and `staging.pokemonkarten.at` point to the
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

Staging is protected with basic auth, except `/api/stripe/webhook` and `/api/v1/*`, which
authenticate themselves.

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

Check: `infra/stack.sh production ps` (web and worker healthy), `curl -fsS https://pokemonkarten.at/api/health`.

## 7. First start

1. The worker notices the empty card master data and runs the TCGdex sync on its own (about two
   minutes; afterwards every night between 3 and 5 o'clock). Check in the admin under
   _Übersicht → Kartendaten_.
2. Sign in at `https://<host>/admin` with your Microsoft account (docs/m365-setup.md, part B).
3. Create the scanning app's key under _API-Schlüssel_ (owner only). The secret is shown once.
   Without the admin sign-in configured yet, the same works from the server:
   `infra/stack.sh production exec worker node apps/worker/src/cli.ts api-client create "Scanner Lager"`
4. Point the scanning app at `https://staging.pokemonkarten.at/api/v1` first and send a test card;
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

### Stripe of Antalyse GmbH (app licences)

App licences are paid to the GmbH's own Stripe account. In that account (test mode for staging):

1. **Payment methods** and **Branding** as above (name: Antalyse GmbH / ScanPM).
2. **Stripe Tax** (Settings → Tax): origin address Wienerstraße 1, 2440 Moosbrunn; registrations
   for Austria and the EU One-Stop-Shop (union scheme), so Stripe charges the buyer's country's
   VAT to consumers. Default tax behaviour does not matter: the shop sets it per payment.
3. **Invoices** (Settings → Billing → Invoices): add the UID ATU79907228 as the account's tax id
   and make it the default on invoices (or put its `txi_…` id into
   `STRIPE_LICENSE_ACCOUNT_TAX_IDS`); choose the invoice number prefix and the PDF template. Leave
   "Email finalized invoices to customers" off: the shop sends invoice and credit note itself.
4. **API key** into `STRIPE_LICENSE_SECRET_KEY` (a restricted key needs write access to Checkout
   Sessions, Customers, Invoices, Credit Notes and Refunds).
5. **Webhook** `https://<host>/api/stripe/webhook-licenses` with the same six events as above;
   its signing secret into `STRIPE_LICENSE_WEBHOOK_SECRET`.

Business buyers' EU VAT ids are checked live against VIES
(`ec.europa.eu/taxation_customs/vies`); the server must be able to reach it. The licence e-mails
are sent from the GmbH's mailbox set in Admin › App (`info@abc-it.at` to start with): that
mailbox must be in the same Microsoft 365 tenant and inside the mail app's scope
(docs/m365-setup.md, A.3).

Test on staging: buy as a private person in Austria (20 % VAT in the total), as a German
business with a VAT id (net, reverse charge) and as a US business (net); check the invoice PDF in
the licence mail and refund one order in the admin (Stripe credit note attached to the refund
mail).

## 10. Backups and restore test

The vServer (including the `media` volume with product images) and the PostgreSQL server are
covered by the existing backups. Once a quarter, restore the latest `pokeshop` dump into a
scratch database and start a staging stack against it.
