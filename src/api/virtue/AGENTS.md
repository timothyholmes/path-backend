# Virtues module

Virtues, their derived levels, and per-virtue XP history (`/virtues`). Router → Service → Storage,
wired in `src/routers.ts` and `src/dependencies.ts`; see the root `CLAUDE.md` for the layering rules
this follows. Tests: `test/api/virtue/virtues.test.ts`.

## Before you change anything

- **The pool bypasses RLS** (`src/api/shared/db.ts`). Every query filters `user_id` explicitly.
  A missing `user_id` predicate is a cross-tenant read, not a style nit.
- **One table, and everything else points at it.** `virtues` is the parent of `routine_virtues`,
  `goal_virtues`, `session_virtues`, `field_log_virtues`, `goal_backlog.virtue_id`, and
  `xp_ledger.virtue_id` — all through the `(id, user_id)` pair, which makes "my routine tagged with
  your virtue" unrepresentable. A change to this table's keys ripples through all six.
- **`express-openapi-validator` does not enforce request-body schemas against this OpenAPI 3.1
  document.** A missing `name`, a `color` that is not a hex triplet, an over-long name and a
  non-integer `display_order` all reach the database, and so does a `from`/`to` that parses as a
  string but not as a date (`2026-02-30`); `mapWriteError` turns the resulting
  23502/23514/22001/22P02/22007 into 400s. Without that they surface as 500s. This is a repo-wide
  gap, not a virtues-specific one — do not assume the schema is protecting a new field you add.

## XP and level are read-only here

`virtues.xp` and `virtues.level` are maintained by `public.calculate_and_award_xp` and derived from
the append-only ledger. `VirtueCreate`/`VirtueUpdate` expose neither, and the router forwards only
the four presentation fields, so a client that sends `xp` or `level` has them dropped rather than
written. Never compute XP or a level in TypeScript — `public.level_for_xp()` owns the curve.

## The free-tier cap is the starter set

Signup seeds exactly four virtues (`public.handle_new_user()`), and `virtues_plan_limit` caps a free
user at four. So a free user's **first** create is already the one over the line — `POST /virtues`
returns 402 until they delete one or go premium. That is why almost every create test in
`virtues.test.ts` deletes a starter virtue first, or runs as a premium user.

The trigger is `AFTER INSERT` only, so unlike `goals` and `routines` there is no 402 on update: a
virtue has no `is_active`-style flag that could bring a user back over the cap.

## Deleting a virtue keeps its XP

Untagging is all cascade — `routine_virtues`, `goal_virtues`, `session_virtues`,
`field_log_virtues` lose their rows and `goal_backlog.virtue_id` goes null. The ledger is the
exception: `xp_ledger.virtue_id` is set to null and the row survives.

That took a migration (`20260920024902_retain_xp_ledger_on_virtue_delete`). The original FK
cascaded, which broke two things at once: api-spec.yml promises the XP "is retained (the ledger is
append-only)", and `profiles.global_xp` is a running total that is never recomputed from the ledger,
so erasing rows left the profile total unexplainable by the ledger meant to explain it. `virtue_id`
was already nullable for global-only XP, so orphaning is representable. Pinned by
`supabase/tests/06_constraints.sql` and by "retains the XP the virtue earned, orphaned from it".

Consequence worth knowing: after a delete, `GET /virtues/{id}/history` for that virtue 404s and its
XP is no longer attributable to any virtue, but it still counts toward the global level.

## History is charted in the user's timezone

`GET /virtues/{id}/history` aggregates `xp_ledger` by `(created_at at time zone profiles.timezone)`,
the same bucketing `daily_activity` and the streak logic use, so a point is the day the user
experienced rather than UTC's.

- **Only days with activity get a point.** `date` is explicit on every point, so a chart can render
  gaps itself instead of paying for a row per empty day.
- **`cumulative_xp` is all-time through that day, not the total within the window.** XP earned
  before `from` is summed into a baseline, so `level` is the level actually held and a windowed
  request agrees with an unwindowed one. Drop the baseline and the level on a windowed chart becomes
  fiction.
- Both bounds are inclusive, and an inverted window is rejected in the router (a 400) — the OpenAPI
  schema cannot relate two parameters to each other.
- An unwindowed request returns the whole history. There is no default window; api-spec.yml
  documents none, and inventing one would silently truncate a chart.

## Running the tests

They need a real PostgreSQL server and skip themselves when `DATABASE_URL` is unset. Use a stock
Postgres container, not the Supabase stack: each test file creates its own database, and `pg_cron`
can only be installed in `postgres`, so `20260804121400_cron.sql` fails against Supabase's image.

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 5434:5432 postgres:17
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5434/postgres PATH_DB_MODE=bare \
  npx vitest --pool=forks run test/api/virtue/virtues.test.ts
```

Shared scaffolding lives in `test/api/shared/`: `createDbTestApp` (real `Server`, real validator,
real routers) and `seedUser`, whose `virtueIds` are the four starter virtues in display order and
whose options set timezone, subscription tier, and expiry for the 402 cases.
