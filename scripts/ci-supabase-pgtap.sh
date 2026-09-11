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

# pgTAP proves the policies from inside the database, with `set local role`.
# This suite proves the same guarantees from outside, over PostgREST, which is
# the path the mobile client actually takes and where schema exposure and table
# grants can undo a correct policy.
echo "Running PostgREST RLS suite..."
eval "$(pnpm exec supabase status -o json | python3 -c '
import json, shlex, sys
status = json.load(sys.stdin)
for var, key in (
    ("SUPABASE_API_URL", "API_URL"),
    ("SUPABASE_ANON_KEY", "ANON_KEY"),
    ("SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY"),
):
    print(f"export {var}={shlex.quote(status[key])}")
')"
pnpm exec vitest --pool=forks run test/db/postgrest.test.ts

echo "Checking generated types are current..."
pnpm run db:types
git diff --exit-code db/types.generated.ts \
  || (echo "db/types.generated.ts is stale. Run 'npm run db:types' and commit the result." && exit 1)
