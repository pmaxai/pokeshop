# Technical decisions

Short records of choices that shape the code. Newest first.

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
