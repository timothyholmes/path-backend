# Path AI — Backend

Backend for **Path AI**, a personal productivity system built around Virtues: habit tracking, goals and
quests, focused work sessions, journaling, and AI retrospectives, all scored through a shared XP and
leveling engine.

`api-spec.yml` (OpenAPI 3.1) is the contract for the HTTP surface. The database lives in
`supabase/` and is where the load-bearing logic runs — XP scoring, streak math, and multipliers are
PostgreSQL functions, and Row Level Security is the actual boundary between users.

> The `src/api/reservation` and `src/api/availability` modules are a room-reservations sample left over
> from the project scaffold — a worked example of the Router → Service → Storage layering, not Path AI.
> `src/api/routine` and `src/api/session` are the real Path AI resources: they implement the
> `/routines` and `/sessions` endpoints from `api-spec.yml` against the real Postgres schema in
> `supabase/`, following the same layering. Further Path AI resources belong here too, unless/until
> they move to Supabase Edge Functions.

---

## Prerequisites

| Requirement | Notes                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Node.js     | Version pinned in `.nvmrc` (26.3.0). `nvm use` picks it up.                                                        |
| pnpm        | The repo's package manager; `pnpm-lock.yaml` is the lockfile.                                                      |
| Docker      | Needed for the local Supabase stack and for running the database tests. Must be running before `npm run db:start`. |

The Supabase CLI is installed as a dev dependency — no global install required.

## Setup

```bash
nvm use
pnpm install
```

That is enough to run the Express sample and its tests. For anything touching the database, start the
local Supabase stack:

```bash
npm run db:start
```

The first run pulls several container images and takes a few minutes. When it finishes it prints the
local URLs and keys:

| Service         | URL                                                     |
| --------------- | ------------------------------------------------------- |
| API (PostgREST) | http://127.0.0.1:54321                                  |
| PostgreSQL      | postgresql://postgres:postgres@127.0.0.1:54322/postgres |
| Studio          | http://127.0.0.1:54323                                  |
| Mailpit (email) | http://127.0.0.1:54324                                  |

`npm run db:stop` shuts it down.

### Configuration

Config is layered: `config/default.yml`, deep-merged with `config/{NODE_ENV}.yml` (defaults to
`development`). The `database.url` in `config/default.yml` already points at the local Supabase stack, so
no setup is needed for local work. `DATABASE_URL` overrides it when set.

Secrets are stored encrypted in the YAML as `ENC(iv:authTag:ciphertext)` and decrypted at load time
using `CONFIG_ENCRYPTION_KEY` (a 64-character hex string). Never commit a plaintext secret.

```bash
# Generate a key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Encrypt a value, then paste the printed ENC(...) into the relevant config/*.yml
CONFIG_ENCRYPTION_KEY=<key> npx ts-node scripts/encrypt-secret.ts "my secret"
```

`config/secrets.yml` is gitignored for local-only overrides.

---

## Running

### Database

```bash
npm run db:start        # Start the local Supabase stack (needs Docker)
npm run db:stop         # Stop it
npm run db:reset        # Drop, re-apply every migration, run supabase/seed.sql
npm run db:seed         # Seed a richer scenario (see below)
npm run db:types        # Regenerate db/types.generated.ts after a schema change
```

`db:reset` leaves you with a signed-in-able developer account:

| Email           | Password            |
| --------------- | ------------------- |
| `dev@path.test` | `path-dev-password` |

### Schema changes

Migrations are hand-written SQL in `supabase/migrations/`, applied in filename order, and are the source
of truth for the schema.

```bash
npm run db:migrate:new -- add_something   # Scaffold a timestamped migration
npm run db:reset                          # Re-apply everything from scratch
npm run db:types                          # Regenerate types; commit the result
```

`npm run db:diff` captures ad-hoc changes made in Studio into a new migration file. `npm run db:push`
applies pending migrations to a linked remote project.

After any schema change, re-run `npm run db:types` and commit `db/types.generated.ts` — CI fails if it is
stale.

### Test data

Scenarios live in `db/seed/scenarios/` and are chosen explicitly:

```bash
npm run db:seed -- --scenario=premium-power-user
npm run db:seed -- --scenario=edge-cases --as-of=2026-08-04
```

| Scenario             | What it produces                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty`              | Nothing. A migrated database with no users.                                                                                                                            |
| `new-user`           | One fresh signup: profile plus four starter virtues, no activity.                                                                                                      |
| `active-free`        | A free user sitting exactly on every plan cap, with two weeks of history and a live streak.                                                                            |
| `premium-power-user` | 90 days across every feature: streak at the 2.0 cap, sessions with partial credit and skips, templated field logs with AI analysis, weekly and monthly retrospectives. |
| `edge-cases`         | Broken streaks, negative XP, null-virtue ledger rows, partition boundaries, four-deep goal nesting, a lapsed subscription.                                             |

Ids are derived with `uuidv5`, so they are identical on every run and safe to hard-code in a test.
`--as-of` pins the date a scenario treats as "today"; it defaults to now, so a scenario describing a live
streak produces one. Seeding refuses to run twice for the same user — reset first.

### The Express sample

```bash
npm run dev             # Hot reload on http://localhost:3000
npm run build && npm start
```

Swagger UI is served at `/docs`.

---

## Testing

Three suites. All of them run in CI (`.github/workflows/ci.yml`).

### Unit and integration (vitest)

```bash
npm test                # Everything
npm run test:watch      # Watch mode
```

Tests under `test/db/`, `test/api/routine/`, and `test/api/session/` need a PostgreSQL server and **skip themselves when
`DATABASE_URL` is unset**, so `npm test` works on a fresh checkout with nothing running. To include them,
point at a database:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test
```

Each database test file creates and drops its own throwaway database, so the suites do not interfere with
each other or with your seeded data.

Run a single file:

```bash
npx vitest --pool=forks run test/db/seed.test.ts
```

### Database behaviour (pgTAP)

The assertions that only make sense inside the database — RLS isolation, the scoring and level functions,
plan limits, constraints, partition routing — live in `supabase/tests/` and run against the local stack:

```bash
npm run db:start
npm run db:test
```

### RLS over PostgREST

pgTAP proves the policies from inside the database, with `set local role authenticated` and a
hand-written `request.jwt.claims`. That skips the layer the mobile client actually uses: schema
exposure, the JWT-to-role mapping, table and column grants, and resource embedding all sit between a
correct policy and the wire, and any one of them can undo it. `test/db/postgrest.test.ts` asserts the
same guarantees from outside over HTTP, holding nothing but the published anon key and a user JWT.

It needs a running stack and skips itself otherwise, the same way the `DATABASE_URL` tests do:

```bash
npm run db:start
eval "$(npx supabase status -o env | grep -E '^[A-Z_]+=' | sed 's/^/export SUPABASE_/')"
npx vitest --pool=forks run test/db/postgrest.test.ts
```

`./scripts/ci-supabase-pgtap.sh` runs it alongside pgTAP.

### Against a plain PostgreSQL server

The migrations carry no Supabase-specific branches. A compat shim
(`db/compat/0000_supabase_shim.sql`) supplies the `auth` schema, `auth.uid()`, and the PostgREST roles,
so the exact same SQL runs on a stock PostgreSQL container. This is what CI uses, and it is the fastest
way to check a migration locally without the full stack:

```bash
docker run -d --name path-pg -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:17

export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/postgres
export PATH_DB_MODE=bare

npm run db:migrate      # Apply migrations
npm run db:reset:bare   # Or drop everything and re-apply
npm test                # Database tests now run

docker rm -f path-pg
```

`PATH_DB_MODE` must be `bare` for a non-Supabase server; it defaults to `supabase`. `db:reset:bare`
refuses to touch a non-local host unless passed `--force`.

### Lint, format, types

```bash
npm run lint            # eslint
npm run lint:fix
npm run format          # prettier --write
npm run format:check
npm run typecheck       # tsc --noEmit over src, test, and db
```

---

## Mobile app

`apps/mobile` is the Path AI client: Expo + Expo Router (TypeScript), targeting iOS, Android, and web
from one codebase. It talks to the local Supabase stack directly via `@supabase/supabase-js`, per the
RLS-as-boundary design described in `CLAUDE.md`.

```bash
pnpm install                         # from the repo root; installs backend + app
npm run db:start                     # starts the local Supabase stack (needs Docker)
```

The Supabase CLI is a devDependency rather than a global, so reach for it through `npx`. This writes
the app's env file straight from the running stack, which beats copying two long values by hand:

```bash
npx supabase status -o env | sed -n 's/^ANON_KEY=/EXPO_PUBLIC_SUPABASE_ANON_KEY=/p; s/^API_URL=/EXPO_PUBLIC_SUPABASE_URL=/p' | tr -d '"' > apps/mobile/.env.local
```

Then start Expo (`w` for web, `i` for the iOS simulator, `a` for Android):

```bash
pnpm --filter mobile start
```

Sign in with the account `supabase/seed.sql` creates: **dev@path.test** / **path-dev-password**.

It's part of the pnpm workspace (`pnpm-workspace.yaml`), so `pnpm install` at the repo root installs
both the backend and the mobile app's dependencies.

### How the client talks to the database

There is no API server in this path. `apps/mobile/lib/supabase.ts` holds the anon key, sign-in
exchanges it for a user JWT, and every query from then on goes straight to PostgREST — so the RLS
policies in `supabase/migrations/20260804121200_rls.sql` are the whole boundary between one user's
data and another's. `components/Home.tsx` is the worked example: none of its three queries filters on
`user_id`, because adding one would only hide whether the policies work.

The client is typed with the generated `Database` type, so a column that does not exist is a compile
error rather than a PostgREST 400 at runtime. Regenerate it with `npm run db:types` after any
migration.

Two things to know when running locally:

- **`JWT issued at future` right after signing in.** The auth and REST containers can drift a
  fraction of a second apart, and PostgREST rejects a token whose `iat` is ahead of its clock. It
  clears on the next request or a reload; `npm run db:stop && npm run db:start` resets it.
- **`calculate_and_award_xp` needs an explicit `p_source_id`.** It is the one parameter without a SQL
  default, so the generated type marks it required and non-null even though the column is nullable
  and global bonus XP has no source row. Callers pass `null` through a cast; see the comment in
  `components/Home.tsx`.

## Layout

```
api-spec.yml              OpenAPI contract for the HTTP surface
apps/mobile/              Expo Router app (iOS, Android, web) — the Path AI client
config/                   Layered YAML config with encrypted secrets
src/                      Express app; api/reservation & api/availability are scaffold,
                          api/routine & api/session are real
supabase/
  migrations/             Schema, functions, RLS, plan limits, cron — source of truth
  seed.sql                Baseline dev account, applied by `db:reset`
  tests/                  pgTAP: RLS, scoring, streaks, plan limits, constraints
db/
  migrate.ts              Applies migrations to any DATABASE_URL
  reset.ts                Bare-PostgreSQL equivalent of `supabase db reset`
  client.ts               Connection built from the config loader
  compat/                 Supabase shim for stock PostgreSQL
  seed/                   Deterministic scenario seeding
  types.generated.ts      Generated — run `npm run db:types`, do not edit
test/
  routes/                 Express sample tests
  db/                     Migration runner and seeder tests
```

See `CLAUDE.md` for the architectural conventions the database layer follows.
