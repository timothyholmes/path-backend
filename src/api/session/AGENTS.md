# Sessions module

Focused work sessions (`/sessions`) and their timed instances. Router → Service → Storage, wired in
`src/routers.ts` and `src/dependencies.ts`; see the root `CLAUDE.md` for the layering rules this
follows. Tests: `test/api/session/sessions.test.ts`.

## Before you change anything

- **`api-spec.yml` is the contract, and `validateResponses` is on** (`src/server.ts`). A status code
  the spec doesn't list for an operation is not a 4xx to the client — it fails response validation
  and surfaces as a 500. `/sessions/{id}/skip` in particular has **no 409**, which is why skip always
  records an instance instead of refusing (see below).
- **The pool bypasses RLS** (`src/api/shared/db.ts`). Every query filters `user_id` explicitly.
  A missing `user_id` predicate is a cross-tenant read, not a style nit.
- **Three tables, one owner**: `sessions`, `session_virtues`, `session_instances`. The child tables
  reference `(id, user_id)`, so a cross-user row is unrepresentable.

## XP semantics

Scoring runs in the database (`public.calculate_and_award_xp`); never compute XP in TypeScript beyond
choosing the base amount to hand it.

| Endpoint                   | Base XP passed to the function              | `source_type` | Virtues            |
| -------------------------- | ------------------------------------------- | ------------- | ------------------ |
| `POST /sessions/{id}/end`  | `floor(base_xp × min(elapsed / target, 1))` | `session`     | the session's tags |
| `POST /sessions/{id}/skip` | `-floor(base_xp × 0.25)`                    | `penalty`     | none               |

- **The cap at proportion 1 is deliberate**: ending early earns partial credit, overrunning the target
  does not earn more than finishing it.
- **A skip is un-multiplied and is not activity.** `calculate_and_award_xp` forces multiplier 1.0 for
  negative base XP and records `completion_count = 0`, so a skip cannot be amplified by a long streak
  and cannot keep a streak alive. Attributing the loss to a virtue would drain that virtue's XP, so
  `virtue_ids` is empty and the ledger row is global-only.
- Ledger descriptions match what `db/seed/scenarios/premiumPowerUser.ts` writes — `Session completed:`,
  `Partial session:`, `Skipped session:`. Keep them in step if you change either side.
- Elapsed time is measured against the **database** clock, not the client's, when `end` is called
  without `actual_duration_seconds`.

## base_xp is insert-only

`sessions_default_xp` is a `BEFORE INSERT` trigger. Changing `target_duration_minutes` on an existing
session therefore leaves `base_xp` alone, and this module mirrors that: `base_xp` changes only when a
caller sends it. Do not "helpfully" recompute it on update — a direct PostgREST write from the mobile
client wouldn't, and the two paths must agree.

## The premium gate

Custom durations (anything but 30/60/90) require a live premium subscription. The check mirrors
`private.enforce_plan_limit()`: premium is unlimited only while `subscription_expires_at` is null or
in the future — a lapsed premium user keeps what they have but cannot add more.

Order matters: **a non-positive duration is a 400 before the premium check.** No subscription makes a
zero-minute session valid, and answering "upgrade to unlock" would be a lie. This is also why the
`target_duration_minutes > 0` CHECK is mirrored in application code rather than mapped from a 23514.

There is no plan-limit trigger on `sessions`, so the premium gate is the module's only 402 path.

## Instance lifecycle

`start` resolves to exactly one instance, in this order:

1. **Resume** the session's `in_progress` instance if it has one — same row, `started_at` untouched.
2. **Claim** the pending `scheduled` instance nearest to now (past _or_ future), so starting a
   recurring session a little early or late fills its slot instead of leaving a phantom miss.
3. **Create** an ad-hoc instance with `scheduled_at` null. The `session_instances_slot_idx` unique
   index ignores nulls, so ad-hoc instances never collide.

`skip` marks the nearest pending `scheduled` instance skipped, or records a new `skipped` instance if
there is none — the penalty must always be traceable to an instance, and the spec gives skip no 409.

`delete` relies on the cascade: virtue tags and instances go with the session, which is how an
in-progress instance gets "ended without scoring".

## Locking is load-bearing

`findSession` selects **`for update`**, and every instance transition (`start`, `end`, `skip`) goes
through it. Without that lock, two clients starting the same session at once each see no running
instance — neither transaction can see the other's uncommitted insert — and each inserts one. The
foreign key's implicit key-share lock does _not_ prevent this.

`test/api/session/sessions.test.ts` covers it with "serialises concurrent starts into a single
instance", which drives `SessionStorage` directly: over HTTP the two requests stagger and the race
never appears, so an equivalent supertest version passes even with the lock removed. If you touch the
locking, verify the test actually fails without it before trusting it.

## Running the tests

They need a real PostgreSQL server and skip themselves when `DATABASE_URL` is unset.

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest --pool=forks run test/api/session/sessions.test.ts
```

Against a stock Postgres container instead of the Supabase stack, add `PATH_DB_MODE=bare`. Shared
scaffolding lives in `test/api/shared/`: `createDbTestApp` (real `Server`, real validator, real
routers) and `seedUser`, whose options set subscription tier and expiry for the 402 cases.
