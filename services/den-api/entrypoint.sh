#!/bin/sh
# Den API entrypoint for Railway / Docker.
#  1. Wait for MySQL by retrying the den-db bootstrap (idempotent migrations).
#  2. Exec the upstream entrypoint with the original command.
set -eu

: "${DATABASE_URL:?DATABASE_URL is required (mysql://user:pass@host:3306/db)}"
: "${DEN_DB_ENCRYPTION_KEY:?DEN_DB_ENCRYPTION_KEY is required (32+ chars)}"
: "${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET is required (32+ chars)}"

MIGRATE="${DEN_MIGRATE_ON_START:-true}"
MAX_ATTEMPTS="${DEN_MIGRATE_MAX_ATTEMPTS:-60}"
SLEEP_SECONDS="${DEN_MIGRATE_RETRY_SECONDS:-3}"

if [ "$MIGRATE" = "true" ]; then
  n=0
  cd /app/ee/packages/den-db
  until node ./dist/scripts/bootstrap.js || node --import tsx ./dist/scripts/bootstrap.js; do
    n=$((n + 1))
    if [ "$n" -ge "$MAX_ATTEMPTS" ]; then
      echo "[den-api] den-db bootstrap failed after ${MAX_ATTEMPTS} attempts" >&2
      exit 1
    fi
    echo "[den-api] database not ready or migration failed (attempt ${n}/${MAX_ATTEMPTS}); retrying in ${SLEEP_SECONDS}s"
    sleep "$SLEEP_SECONDS"
  done
  echo "[den-api] den-db bootstrap complete"
  cd /app
fi

exec docker-entrypoint.sh "$@"
