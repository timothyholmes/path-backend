# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # Start with hot reload (ts-node + nodemon)
npm run build          # Compile TypeScript to dist/
npm start               # Run compiled output
npm test                # Run all tests (vitest, fork pool)
npm run test:coverage  # Run all tests with a v8 coverage report
npm run test:watch     # Watch mode
npm run lint            # Lint (eslint .)
npm run lint:fix       # Lint and auto-fix
npm run format          # Format the repo with Prettier
npm run format:check   # Check formatting without writing
npm run typecheck      # tsc --noEmit over src, test, and db
```

Run a single test file:

```bash
npx vitest --pool=forks run test/api/reservation/reservations.test.ts
```

### Testing & coverage

These rules are non-negotiable — CI and reviewers enforce them:

- **Run the full suite during development.** Run `npm test` (all tests, not just
  the file you touched) before considering any change done; a single-file run is
  only for tight inner-loop iteration, never the final check.
- **Every new or changed behaviour ships with tests.** New code — a function,
  branch, endpoint, error path — is not complete until tests exercise it. Do not
  open a change that adds untested code.
- **Coverage may not decrease.** `npm run test:coverage` must report a total at
  or above the current baseline; a change that lowers it is incomplete. Raising
  it is always welcome.
- **Never exclude code to protect the number.** The measured surface is all
  application source (`src/**`), and the coverage config's `exclude` list must
  stay empty. Do not carve out files, add ignore hints, or narrow `include` to
  make coverage look better — cover the code instead. (Generated artifacts are
  not hand-written source and are simply outside `include`.)

### Database

```bash
npm run db:start        # Start the local Supabase stack (needs Docker)
npm run db:stop         # Stop it
npm run db:reset        # Drop, re-apply all migrations, run supabase/seed.sql
npm run db:migrate:new  # Scaffold a migration: npm run db:migrate:new -- <name>
npm run db:diff         # Diff the live schema into a new migration
npm run db:push         # Apply pending migrations to a linked remote project
npm run db:seed         # Seed a scenario (see below)
npm run db:types        # Regenerate db/types.generated.ts
npm run db:test         # pgTAP suite (supabase/tests)
```

Against a plain PostgreSQL server (no Supabase), set `PATH_DB_MODE=bare`:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/postgres PATH_DB_MODE=bare npm run db:migrate
```

### Running CI locally

`.github/workflows/ci.yml` has three jobs, each a thin wrapper around a bash
script in `scripts/` — run the same script locally to reproduce a CI failure
exactly, rather than approximating it with ad hoc `npm run` commands:

```bash
pnpm install --frozen-lockfile   # once, matching CI's install (npm's flat
                                  # node_modules can hide missing pnpm-only deps)
npm run ci                       # all three jobs below, in order (needs Docker)

./scripts/ci-lint.sh             # lint + format:check + typecheck
./scripts/ci-database-bare.sh    # migrations twice + tests, against postgres:17 (needs Docker)
./scripts/ci-supabase-pgtap.sh   # full Supabase stack + pgTAP + generated-types check (needs Docker)
```

`ci-database-bare.sh` and `ci-supabase-pgtap.sh` start and tear down their own
containers when `DATABASE_URL` isn't already set (that's how CI, which
provisions Postgres itself, invokes them unchanged).

## Repo layout

This is a pnpm workspace (`pnpm-workspace.yaml`: `.` and `apps/*`). The repo root is the Express/Supabase
backend described below. `apps/mobile` is the Path AI client — Expo + Expo Router (TypeScript), targeting
iOS, Android, and web from one codebase, talking to Supabase directly via `@supabase/supabase-js` (see
`apps/mobile`'s own `CLAUDE.md`/`AGENTS.md` for Expo-specific guidance, and the root README's "Mobile app"
section for setup). `pnpm install` at the root installs both.

## Architecture

Express 5 + TypeScript backend for a room reservations API. The OpenAPI spec (`api-spec.yml`) is the source of truth — `express-openapi-validator` enforces request/response validation against it at runtime, and Swagger UI is served at `/docs`. Any new endpoint or field must be added to `api-spec.yml` or requests/responses will fail validation.

**Wiring pattern** — `Server` is a generic builder class (`src/server.ts`), parameterized by `Config` and `Dependencies`, that chains:

1. `.withOpenApiSpec(path)` — mounts the validator + Swagger UI
2. `.withDependencies(getDependencies, overrides?)` — instantiates services/storage; `overrides` allow test injection
3. `.withRouters(getRouters)` — mounts route handlers and registers the global error handler (must run last; throws if dependencies aren't set yet)

`src/index.ts` assembles the real server; `test/helpers.ts:createTestApp()` assembles an identical stack for tests, wrapped in `supertest`.

**Config loading** (`src/config.ts`) — `ConfigLoader` reads `config/default.yml`, deep-merges it with `config/{NODE_ENV}.yml` (defaults to `development`), then walks the merged object decrypting any string values of the form `ENC(iv:authTag:ciphertext)` using AES-256-GCM with a key from `CONFIG_ENCRYPTION_KEY` (64-char hex env var). Encrypt new secrets with `scripts/encrypt-secret.ts` and paste the resulting `ENC(...)` value into the relevant `config/*.yml` — never commit plaintext secrets. `config/secrets.yml` is gitignored for local-only overrides.

**Resource pattern (Router → Service → Storage)** — The Reservation/Availability code is a worked example of the layering every resource follows; new resources should be added the same way, not as one-off code.

Each resource lives in its own vertical module folder under `src/api/<resource>/`, with all three layers co-located:

```
src/api/reservation/
  ReservationRouter.ts
  ReservationService.ts
  ReservationStorage.ts
```

Tests mirror the same structure under `test/api/<resource>/`, with any resource-specific fixtures kept alongside the tests:

```
test/api/reservation/
  reservations.test.ts
  fixtures.ts
```

The three layers:

- **Router** (e.g. `src/api/reservation/ReservationRouter.ts`) — a class taking `(config, dependencies)` in its constructor, with one method per HTTP verb, bound into `express.Router` inside `src/routers.ts` (e.g. `reservation.create.bind(reservation)`). Handles only things the OpenAPI schema can't express (e.g. `endTime > startTime`) by throwing a `ServerError` subclass, then delegates to a service and maps the result to a status code.
- **Service** (e.g. `src/api/reservation/ReservationService.ts`) — business logic: id generation (`uuid`), CRUD, and cursor-paginated search. Throws `NotFound`/`Conflict`/`ServerError` for domain failures; a service only depends on the storage/services it's given via `Pick<Dependencies, ...>`, not the full `Dependencies` object.
- **Storage** (e.g. `src/api/reservation/ReservationStorage.ts`) — a thin wrapper around an in-memory `Map`, implementing `Symbol.iterator` so other services can scan the underlying data without reaching into internals (this is how `AvailabilityService` derives room availability from `ReservationStorage` without its own storage).

**Dependency graph** (`src/dependencies.ts`): `getDependencies` builds `ReservationStorage`, then `ReservationService` and `AvailabilityService` on top of it (both share the one storage instance), threading `overrides` through at each step for test injection.

**Error handling** (`src/errors/`): `ServerError` is the base class (`message`, HTTP `code`, `type` string, optional wrapped `originalError`); `NotFound`, `BadRequest`, and `Conflict` are prebuilt subclasses pinned to their status/reason phrase (`http-status-codes`) — reach for these (or add a new subclass the same way) rather than throwing raw errors. The global handler registered in `Server.withRouters` catches `ServerError` instances and formats `{ error, message }` JSON; `express-openapi-validator` schema-violation errors (shaped `{ status, message }`) flow through the same handler.

**Tests** use `supertest` against a real `Server` instance — no mocks. `test/helpers.ts:createTestApp()` is the shared test factory. Resource-specific fixtures (e.g. `test/api/reservation/fixtures.ts`) live inside each module's test folder.

**Storage (Express sample only)**
The Reservation/Availability code is leftover scaffolding and stores everything in a `Map` by design — do not add persistence to _it_, and it is fine for it to lose data between restarts. This says nothing about the Path AI database below, which is a real PostgreSQL schema.

## Database

Path AI's backend is Supabase (technical design §2). The database is not a passive store: XP scoring, streak math, and the multiplier logic run as PostgreSQL functions so completions are transactional and free of read-modify-write races, and Row Level Security is the actual boundary between users because the mobile client is allowed to query PostgREST directly.

**Migrations** (`supabase/migrations/*.sql`) are the source of truth for the schema — hand-written SQL, applied in filename order. Create one with `npm run db:migrate:new -- <name>` so it gets a proper timestamp. Two runners apply the identical files:

- The Supabase CLI (`db reset`, `db push`) for local and deployed Supabase.
- `db/migrate.ts` for any `DATABASE_URL`, including a stock `postgres:17` container in CI. It writes the same `supabase_migrations.schema_migrations` ledger the CLI reads, so the two stay interchangeable.

**Bare-PostgreSQL mode** — `db/compat/0000_supabase_shim.sql` creates the `auth` schema, `auth.uid()`/`auth.jwt()`/`auth.role()`, and the `anon`/`authenticated`/`service_role` roles, applied only when `PATH_DB_MODE=bare`. This exists so migrations never need Supabase-specific branches; write them as if Supabase is always there.

**Layout**

- `supabase/migrations/` — schema, functions, RLS, plan limits, cron
- `supabase/seed.sql` — one dev account, applied by `supabase db reset`
- `supabase/tests/` — pgTAP: RLS isolation, scoring, streaks, plan limits, constraints
- `db/seed/` — deterministic scenario seeding
- `db/types.generated.ts` — generated; regenerate with `npm run db:types` after any schema change
- `test/db/` — vitest coverage for the runner and the seeder

**Conventions**

- `timestamptz` everywhere. Streaks reset at each user's local midnight, which naive timestamps cannot express.
- Every user-scoped table carries a denormalised `user_id` so RLS policies are a flat `auth.uid() = user_id`. Child tables reference the parent's `(id, user_id)` pair, which makes cross-user rows unrepresentable rather than merely discouraged.
- New tables need RLS enabled plus the four owner policies, and explicit grants (`authenticated` only; revoke from `anon`). `supabase/tests/00_schema.sql` fails if any public table has RLS off.
- `SECURITY DEFINER` functions must pin `search_path` and check `auth.uid()` themselves — they bypass RLS, and PostgREST exposes them as RPC to any signed-in user.
- Free-tier caps are enforced by `AFTER ... FOR EACH STATEMENT` triggers with transition tables, not per-row triggers: a row-level trigger cannot see the rest of its own statement, so one multi-row INSERT would bypass it.
- `xp_ledger` is partitioned by month, with partitions in the `private` schema so they are unreachable through PostgREST. Backdating rows requires calling `private.ensure_xp_ledger_partitions()` first.

**Seeding** — scenarios live in `db/seed/scenarios/` and are chosen explicitly:

```bash
npm run db:seed -- --scenario=premium-power-user
```

`empty`, `new-user`, `active-free` (at every plan cap), `premium-power-user` (90 days, streak at the 2.0 cap, all premium features), `edge-cases` (broken streaks, negative XP, partition boundaries, lapsed subscription). Ids are derived with `uuidv5`, so they are identical on every run and safe to hard-code in a test. Scenarios append XP ledger rows and let `finalize()` derive virtue XP, levels, `daily_activity`, and streaks from them — never compute XP totals in TypeScript.

## Key conventions

- Times are epoch milliseconds (`startTime`, `endTime`)
- Pagination uses opaque string cursors (the last item's id); `limit` is query-param-driven, default 500
- `PORT` is read from `process.env.PORT`, defaulting to 3000
- 2-space indentation, single quotes, semicolons, trailing commas — enforced by ESLint (`eslint.config.mjs`, flat config, `typescript-eslint` recommended rules) and Prettier; run `npm run lint` / `npm run format` before committing
