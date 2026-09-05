#!/usr/bin/env bash
# Mirrors the "RLS and database functions (pgTAP)" CI job: starts a full local
# Supabase stack, runs the pgTAP suite, and checks db/types.generated.ts is
# current. Needs Docker (via the Supabase CLI). Run after `pnpm install`.
set -euo pipefail
cd "$(dirname "$0")/.."

cleanup() {
  pnpm exec supabase stop --no-backup >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting Supabase..."
pnpm exec supabase start

echo "Running pgTAP suite..."
pnpm run db:test

echo "Checking generated types are current..."
pnpm run db:types
git diff --exit-code db/types.generated.ts \
  || (echo "db/types.generated.ts is stale. Run 'npm run db:types' and commit the result." && exit 1)
