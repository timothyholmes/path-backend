#!/usr/bin/env bash
# Mirrors the "Migrations and seeding (bare PostgreSQL)" CI job: applies every
# migration to a stock postgres:17 database via the compat shim, twice (the
# second run must be a no-op), then runs the full test suite against it.
#
# In CI, the postgres service container and DATABASE_URL/PATH_DB_MODE are
# already set up by the workflow. Locally, with no DATABASE_URL set, this
# spins up its own postgres:17 container via Docker. Run after `pnpm install`.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER_NAME=path-backend-ci-postgres
PORT="${PATH_CI_DB_PORT:-5433}"

if [ -z "${DATABASE_URL:-}" ]; then
  cleanup() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT
  cleanup

  echo "Starting postgres:17 on port ${PORT}..."
  docker run -d --name "$CONTAINER_NAME" \
    -e POSTGRES_PASSWORD=postgres \
    -p "${PORT}:5432" \
    postgres:17 >/dev/null

  echo "Waiting for Postgres to be ready..."
  until docker exec "$CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; do
    sleep 1
  done

  export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres"
  export PATH_DB_MODE=bare
fi

echo "Applying migrations..."
pnpm run db:migrate

echo "Re-applying migrations (must be a no-op)..."
pnpm run db:migrate

echo "Running tests..."
pnpm test
