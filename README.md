# Path AI — Backend

Backend for **Path AI**, a personal productivity system built around Virtues: habit tracking, goals and
quests, focused work sessions, journaling, and AI retrospectives, all scored through a shared XP and
leveling engine.

`api-spec.yml` (OpenAPI 3.1) is the contract for the HTTP surface. The database lives in
`supabase/` and is where the load-bearing logic runs — XP scoring, streak math, and multipliers are
PostgreSQL functions, and Row Level Security is the actual boundary between users.

> The `src/api/reservation` and `src/api/availability` modules are a room-reservations sample left over
> from the project scaffold — a worked example of the Router → Service → Storage layering, not Path AI.
> `src/api/routine` is the first real Path AI resource: it implements the `/routines` endpoints from
> `api-spec.yml` against the real Postgres schema in `supabase/`, following the same layering. Further
> Path AI resources belong here too, unless/until they move to Supabase Edge Functions.

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

Tests under `test/db/` and `test/api/routine/` need a PostgreSQL server and **skip themselves when
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

## Layout

```
api-spec.yml              OpenAPI contract for the HTTP surface
config/                   Layered YAML config with encrypted secrets
src/                      Express app; api/reservation & api/availability are scaffold, api/routine is real
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
