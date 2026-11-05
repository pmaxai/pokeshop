#!/usr/bin/env bash
# Runs `docker compose` for one shop stack with the right project name, env file and image,
# so production and staging can never be mixed up.
#
#   infra/stack.sh staging up -d          start or update staging
#   infra/stack.sh production ps          show the production containers
#   infra/stack.sh production logs -f web follow the production shop log
#
# Reads /opt/pokeshop/<stack>.env (settings) and /opt/pokeshop/<stack>.image (one line: the
# image to run, e.g. ghcr.io/pmaxai/pokeshop:sha-e77cccb). Other base folder: POKESHOP_BASE=…
set -euo pipefail

base=${POKESHOP_BASE:-/opt/pokeshop}
stack=${1:-}
case "$stack" in
  production) project=pokeshop; url=https://pokemonkarten.at ;;
  staging) project=pokeshop-staging; url=https://staging.pokemonkarten.at ;;
  *)
    echo "usage: $0 production|staging <docker compose command …>" >&2
    exit 2
    ;;
esac
shift

env_file="$base/$stack.env"
image_file="$base/$stack.image"
[ -r "$env_file" ] || { echo "missing $env_file (copy .env.example and fill it in)" >&2; exit 1; }
[ -r "$image_file" ] || { echo "missing $image_file (one line: the image to run)" >&2; exit 1; }

# Guard against a swapped settings file: the stack must point at its own address.
configured=$(sed -n "s/^PUBLIC_BASE_URL=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}\s*$/\1/p" "$env_file" | tail -n 1)
if [ "${configured%/}" != "${POKESHOP_EXPECT_URL:-$url}" ]; then
  echo "$env_file has PUBLIC_BASE_URL=$configured, expected ${POKESHOP_EXPECT_URL:-$url} for $stack" >&2
  exit 1
fi

ENV_FILE="$env_file"
POKESHOP_IMAGE=$(head -n 1 "$image_file" | tr -d '[:space:]')
SECRETS_DIR=${SECRETS_DIR:-$base/secrets}
export ENV_FILE POKESHOP_IMAGE SECRETS_DIR
exec docker compose -p "$project" -f "$(cd "$(dirname "$0")" && pwd)/compose.yaml" "$@"
