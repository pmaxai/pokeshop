# pokeshop

Online shop for single Pokémon TCG cards at **pokemonkarten.at** – German first, English second,
payments by Stripe, all e-mail through Microsoft Graph, stock fed by a scanning app through a
signed API. Runs as Docker containers; no PHP.

The full requirements are in the concept document (shared separately); technical choices are
recorded in [docs/decisions.md](docs/decisions.md).

## Status

| Milestone                   | Content                                                                       | State     |
| --------------------------- | ----------------------------------------------------------------------------- | --------- |
| M0 Foundation               | Repo, CI, Docker/Caddy, schema, core shop rules                               | done      |
| M1 Catalog and product API  | Data model, TCGdex import, signed API, admin products, DE/EN storefront       | in review |
| M2 Checkout and payments    | Cart, countries, minimum order, 10-minute hold, Stripe, invoices, order mails |           |
| M3 Admin, fulfilment, legal | Orders, pick sheet with boxes, refunds, withdrawal button, events page        |           |
| M4 Hardening and launch     | Security review, load test, monitoring, stock import, DNS switch              |           |

## Layout

```
apps/web          Next.js: storefront (DE/EN), admin (/admin), signed REST API (/api/v1)
apps/worker       background jobs: images, card-data sync; CLI for API keys and sync
packages/core     shop rules shared by web and worker
  src/            money and VAT, shipping and insurance, checkout checks, SKU and boxes,
                  10-minute hold, API request signing, secret encryption, numbering
  migrations/     PostgreSQL schema as numbered SQL files (stock rules as SQL functions)
  test/           unit tests (node:test) and SQL tests
infra/            Dockerfile, compose.yaml, caddy/
docs/             deploy guide, Microsoft 365 setup, API spec, decisions
scripts/          db-test.sh
```

## Development

Requirements: Node.js 22.18+ (26 in production), pnpm 10, PostgreSQL 14+ with `pg_trgm` and
`unaccent`.

```sh
pnpm install
pnpm test:core          # shop rules, no database needed
pnpm test:integration   # products, API keys, jobs, images, card data (temporary databases)
pnpm test:db       # applies all migrations to a temporary database and runs the SQL tests
pnpm typecheck
pnpm format:check
```

Database tests use the usual libpq variables (`PGHOST`, `PGUSER`, `PGPASSWORD`, …); the user needs
`CREATEDB`.

Run the shop locally:

```sh
export DATABASE_URL=postgres://…/pokeshop_dev API_KEY_MASTER_KEY=$(openssl rand -base64 32) \
       PUBLIC_BASE_URL=http://localhost:3000 ADMIN_DEV_LOGIN=true MEDIA_DIR=./.media
pnpm migrate
node apps/worker/src/cli.ts tcgdex sync          # card master data, ~2 minutes
node apps/worker/src/cli.ts api-client create "Scanner Test"
pnpm dev                                          # shop on :3000, admin on /admin
node apps/worker/src/main.ts                      # worker (images, nightly sync)
```

## Deployment

Manual, see [docs/deploy.md](docs/deploy.md). Microsoft 365 app registrations:
[docs/m365-setup.md](docs/m365-setup.md).

## Scanning-app API

Signed REST API under `/api/v1`: [docs/openapi.yaml](docs/openapi.yaml) and
[docs/api-signing.md](docs/api-signing.md).

Not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company.
