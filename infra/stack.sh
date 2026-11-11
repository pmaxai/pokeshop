#!/usr/bin/env bash
# Runs `docker compose` for one shop stack with the right project name, env file and image,
# so production and staging can never be mixed up.
#
#   infra/stack.sh staging up -d --pull always   start or update staging to the newest image
#   infra/stack.sh production ps                 show the production containers
#   infra/stack.sh production logs -f web        follow the production shop log
#   infra/stack.sh production version            which image and commit web is running
#
# Runs the image ghcr.io/pmaxai/pokeshop:<stack>: GitHub moves :staging on every merge into
# main and :production through the "Promote to production" workflow. To pin a version instead,
# put one line into /opt/pokeshop/<stack>.image (e.g. ghcr.io/pmaxai/pokeshop:sha-e77cccb);
# delete the file to follow the tag again. Settings: /opt/pokeshop/<stack>.env.
# Other base folder: POKESHOP_BASE=…
set -euo pipefail

base=${POKESHOP_BASE:-/opt/pokeshop}
stack=${1:-}
case "$stack" in
  production) project=pokeshop; url=https://overpricedcardboard.com ;;
  staging) project=pokeshop-staging; url=https://staging.overpricedcardboard.com ;;
  *)
    echo "usage: $0 production|staging <docker compose command …>" >&2
    exit 2
    ;;
esac
shift

env_file="$base/$stack.env"
image_file="$base/$stack.image"
[ -r "$env_file" ] || { echo "missing $env_file (copy .env.example and fill it in)" >&2; exit 1; }

# Guard against a swapped settings file: the stack must point at its own address.
configured=$(sed -n "s/^PUBLIC_BASE_URL=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}\s*$/\1/p" "$env_file" | tail -n 1)
if [ "${configured%/}" != "${POKESHOP_EXPECT_URL:-$url}" ]; then
  echo "$env_file has PUBLIC_BASE_URL=$configured, expected ${POKESHOP_EXPECT_URL:-$url} for $stack" >&2
  exit 1
fi

ENV_FILE="$env_file"
if [ -s "$image_file" ]; then
  POKESHOP_IMAGE=$(head -n 1 "$image_file" | tr -d '[:space:]')
  echo "note: $stack is pinned to $POKESHOP_IMAGE ($image_file)" >&2
else
  POKESHOP_IMAGE=ghcr.io/pmaxai/pokeshop:$stack
fi
SECRETS_DIR=${SECRETS_DIR:-$base/secrets}
export ENV_FILE POKESHOP_IMAGE SECRETS_DIR
compose=(docker compose -p "$project" -f "$(cd "$(dirname "$0")" && pwd)/compose.yaml")

if [ "${1:-}" = version ]; then
  id=$("${compose[@]}" ps -q web)
  [ -n "$id" ] || { echo "web is not running" >&2; exit 1; }
  docker inspect --format 'image:   {{.Config.Image}}
commit:  {{index .Config.Labels "org.opencontainers.image.revision"}}
created: {{index .Config.Labels "org.opencontainers.image.created"}}
started: {{.State.StartedAt}}' "$id"
  exit 0
fi

exec "${compose[@]}" "$@"
