#!/usr/bin/env bash
# Sets up Invidious + companion + Postgres inside WSL (see docs/BUILD-GUIDE.md, section 8).
#
#   bash setup-invidious.sh              clone Invidious, generate keys, write compose.yaml, start
#   bash setup-invidious.sh --no-start   same, but do not start the containers
#
# INVIDIOUS_DIR overrides the install folder (default: ~/invidious).
# An existing compose.yaml is never overwritten, so your keys survive re-runs.
set -euo pipefail

TARGET="${INVIDIOUS_DIR:-$HOME/invidious}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$HERE/compose.template.yml"

command -v docker >/dev/null || { echo "Docker is not installed in this distro (guide section 7)."; exit 1; }
command -v openssl >/dev/null || { echo "openssl is missing: sudo apt install -y openssl"; exit 1; }
[ -f "$TEMPLATE" ] || { echo "Cannot find $TEMPLATE"; exit 1; }

if [ ! -d "$TARGET/.git" ]; then
  git clone --depth 1 https://github.com/iv-org/invidious.git "$TARGET"
fi

if [ -f "$TARGET/compose.yaml" ]; then
  echo "compose.yaml already exists, keeping it (delete it to generate new keys)."
else
  COMPANION_KEY="$(openssl rand -hex 8)"   # exactly 16 alphanumeric characters
  HMAC_KEY="$(openssl rand -hex 20)"       # must differ from the companion key
  sed -e "s/PUT_COMPANION_KEY/$COMPANION_KEY/g" -e "s/PUT_HMAC_KEY/$HMAC_KEY/g" "$TEMPLATE" > "$TARGET/compose.yaml"
  chmod 600 "$TARGET/compose.yaml"
  echo "Wrote $TARGET/compose.yaml with fresh keys."
fi

# Keep the repo's own docker-compose.yml untouched so `git pull` never conflicts.
echo "COMPOSE_FILE=compose.yaml" > "$TARGET/.env"

if [ "${1:-}" = "--no-start" ]; then
  echo "Done. Start it with: cd $TARGET && docker compose up -d"
else
  (cd "$TARGET" && docker compose up -d)
  echo "Done. Invidious is on http://localhost:3000"
fi
