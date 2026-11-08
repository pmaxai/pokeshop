# syntax=docker/dockerfile:1.7
# One image for the shop. Commands (see infra/compose.yaml):
#   migrate: node packages/core/scripts/migrate.ts
#   web:     pnpm --filter @pokeshop/web start
#   worker:  node apps/worker/src/main.ts
#   license: node apps/license/src/main.ts
# TypeScript files run directly on Node's built-in type stripping.

ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1
# Node 25+ ships without corepack: install the pnpm version pinned in package.json with npm.
RUN --mount=type=bind,source=package.json,target=/tmp/package.json \
    npm install --global --no-fund --no-audit \
      "$(node -p "require('/tmp/package.json').packageManager")" \
 && pnpm --version
WORKDIR /app

# --- dependencies (cached as long as manifests and lockfile do not change) ---
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# --- build the Next.js app ---
FROM deps AS build
COPY . .
RUN pnpm --filter @pokeshop/web build

# --- production dependencies only ---
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    MEDIA_DIR=/data/media
RUN groupadd --system --gid 1001 app \
 && useradd --system --uid 1001 --gid app --create-home --home-dir /home/app app \
 && mkdir -p /data/media \
 && chown app:app /data/media
COPY --from=prod-deps --chown=app:app /app ./
COPY --from=build --chown=app:app /app/apps/web/.next ./apps/web/.next
COPY --chown=app:app apps/web/public ./apps/web/public
COPY --chown=app:app apps/web/next.config.ts apps/web/
COPY --chown=app:app apps/web/messages ./apps/web/messages
COPY --chown=app:app apps/worker/src ./apps/worker/src
COPY --chown=app:app apps/license/src ./apps/license/src
COPY --chown=app:app apps/license/migrations ./apps/license/migrations
COPY --chown=app:app packages/core ./packages/core
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@pokeshop/web", "start"]
