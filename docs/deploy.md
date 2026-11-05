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

## 1. Prerequisites on the vServer

- Docker Engine with the Compose plugin (`docker compose version`).
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
  secrets/graph-cert.pem
```

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
cp infra/caddy/.env.example infra/caddy/.env   # set ACME_EMAIL and the staging password hash
docker compose -f infra/caddy/compose.yaml up -d
```

Staging is protected with basic auth, except `/api/stripe/webhook` and `/api/v1/*`, which
authenticate themselves.

## 5. Image

The image is published by CI for every push to `main` (`:latest`, `:sha-<short>`) and every
`v*` tag. If the GHCR package is private, log in once with a GitHub token that has
`read:packages`:

```sh
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

Alternatively build on the server: `docker build -f infra/Dockerfile -t pokeshop:local .` and use
`POKESHOP_IMAGE=pokeshop:local`.

## 6. Start or update a stack

```sh
cd /opt/pokeshop/app && git pull

# staging first
ENV_FILE=/opt/pokeshop/staging.env POKESHOP_IMAGE=ghcr.io/pmaxai/pokeshop:sha-abc1234 \
  docker compose -p pokeshop-staging -f infra/compose.yaml up -d

# then production, same tag
ENV_FILE=/opt/pokeshop/production.env POKESHOP_IMAGE=ghcr.io/pmaxai/pokeshop:sha-abc1234 \
  docker compose -p pokeshop -f infra/compose.yaml up -d
```

`migrate` runs the database migrations, loads the legal texts (terms, withdrawal, privacy) from
`packages/core/legal` and exits; `web` and `worker` start only after it succeeded. The worker
mounts `/opt/pokeshop/secrets` read-only at `/run/secrets` (other folder: `SECRETS_DIR=…`), so
`GRAPH_CLIENT_CERT_PATH=/run/secrets/graph-cert.pem` finds the mail certificate.

The worker log shows at start what it uses, e.g.
`[worker] started (payments: stripe, mail: graph)`. Without Graph settings mails stay queued in
the database and go out as soon as Graph is configured.

Check: `docker compose -p pokeshop ps` (all healthy), `curl -fsS https://pokemonkarten.at/api/health`.

## 7. First start

1. The worker notices the empty card master data and runs the TCGdex sync on its own (about two
   minutes; afterwards every night between 3 and 5 o'clock). Check in the admin under
   _Übersicht → Kartendaten_.
2. Sign in at `https://<host>/admin` with your Microsoft account (docs/m365-setup.md, part B).
3. Create the scanning app's key under _API-Schlüssel_ (owner only). The secret is shown once.
   Without the admin sign-in configured yet, the same works from the server:
   `docker compose -p pokeshop -f infra/compose.yaml exec worker node apps/worker/src/cli.ts api-client create "Scanner Lager"`
4. Point the scanning app at `https://staging.pokemonkarten.at/api/v1` first and send a test card;
   it appears in the staging shop and under _Produkte_.

## 8. Roll back

Start the previous image tag with the same command. Migrations only ever add; a rollback of the
code works against the newer schema. A destructive schema change will be announced in the
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

## 10. Backups and restore test

The vServer (including the `media` volume with product images) and the PostgreSQL server are
covered by the existing backups. Once a quarter, restore the latest `pokeshop` dump into a
scratch database and start a staging stack against it.
