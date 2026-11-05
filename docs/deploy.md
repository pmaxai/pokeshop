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

Generate the two random secrets per stack:

```sh
openssl rand -base64 32   # SESSION_SECRET
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

`migrate` runs the database migrations and exits; `web` and `worker` start only after it
succeeded. Mount the Graph certificate by adding to the env file
`GRAPH_CLIENT_CERT_PATH=/run/secrets/graph-cert.pem` and a compose override
(`infra/compose.override.example.yaml`, follows with the mail milestone).

Check: `docker compose -p pokeshop ps` (all healthy), `curl -fsS https://pokemonkarten.at/api/health`.

## 7. Roll back

Start the previous image tag with the same command. Migrations only ever add; a rollback of the
code works against the newer schema. A destructive schema change will be announced in the
release notes with its own steps.

## 8. Stripe webhook

In the Stripe Dashboard (test mode for staging, live mode for production) add the endpoint
`https://<host>/api/stripe/webhook` with these events, and put its signing secret into
`STRIPE_WEBHOOK_SECRET`:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `charge.refunded`
- `charge.dispute.created`

## 9. Backups and restore test

The vServer (including the `media` volume with product images) and the PostgreSQL server are
covered by the existing backups. Once a quarter, restore the latest `pokeshop` dump into a
scratch database and start a staging stack against it.
