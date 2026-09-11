# Goals module

Goals, quests, subtasks, and the idea backlog (`/goals`, `/goals/backlog`). Router → Service →
Storage, wired in `src/routers.ts` and `src/dependencies.ts`; see the root `CLAUDE.md` for the
layering rules this follows. Tests: `test/api/goal/goals.test.ts`.

## Before you change anything

- **The pool bypasses RLS** (`src/api/shared/db.ts`). Every query filters `user_id` explicitly.
  A missing `user_id` predicate is a cross-tenant read, not a style nit.
- **Three tables, one owner**: `goals`, `goal_virtues`, `goal_backlog`. The child tables reference
  `(id, user_id)`, so a cross-user row is unrepresentable — including a subtask hung off another
  user's goal, which fails on the composite FK rather than needing its own check.
- **`express-openapi-validator` does not enforce request-body schemas against this OpenAPI 3.1
  document.** A missing `title`, a `status` outside the enum, a malformed uuid and an over-long
  title all reach the database. `mapWriteError` turns the resulting 23502/22P02/22001/22007 into
  400s; without that they surface as 500s. This is a repo-wide gap, not a goals-specific one — do
  not assume the schema is protecting a new field you add.

## XP semantics

Scoring runs in the database (`public.calculate_and_award_xp`); never compute XP in TypeScript
beyond choosing the base amount to hand it.

| Goal completed | Base XP passed to the function | `source_id` | Virtues                     |
| -------------- | ------------------------------ | ----------- | --------------------------- |
| top-level      | `base_xp`                      | the goal    | the goal's tags             |
| quest          | `floor(base_xp × 1.5)`         | the goal    | the goal's tags             |
| subtask        | as above                       | the parent  | its own tags, else parent's |

- **The quest bonus lives here, not in the database.** `calculate_and_award_xp` has no notion of a
  quest, and api-spec.yml promises quests "award a bonus over standard goals", so `QUEST_BONUS_RATE`
  scales the base before handing it over. The streak multiplier and virtue bonus still come from the
  function, so a quest is multiplied like anything else.
- **A subtask's XP belongs to the goal it serves.** The ledger row points at the parent and, when the
  subtask carries no virtues of its own, inherits the parent's. Completing a subtask does not touch
  the parent's status.
- Ledger descriptions match what `db/seed/scenarios/` writes — `Goal completed:`, `Quest completed:`,
  `Subtask completed:`. Keep them in step if you change either side.

## Only `/complete` scores

`PATCH /goals/{id}` can set `status: completed`, and `POST /goals` can create a goal already
completed. Neither awards XP; both are bookkeeping, exactly as a direct PostgREST write from the
mobile client would be. `POST /goals/{id}/complete` is the only endpoint that scores, and it returns
409 for a goal that is already completed — including one completed through a status change.

Both paths still have to carry `completed_at`, because `goals_completed_at_matches_status` requires
the two to agree and neither GoalCreate nor GoalUpdate exposes the timestamp. The stamp is written
only on a real transition, so re-sending `status: "completed"` does not move the completion date.

## The free-tier cap is re-checked on every write

`goals_plan_limit_insert`/`_update` count the user's **active** goals after each statement
(`supabase/migrations/*_plan_limits.sql`), which is why 402 appears on four operations: create,
update, promote — and complete.

Complete is the surprising one. The cap is a count, not a delta, so a user who is _already_ over it
cannot get back under it by completing or archiving: the statement still leaves more than three
active goals and the trigger fires. Only a lapsed premium subscription can reach that state (the
trigger refuses the inserts otherwise), and `test/api/goal/goals.test.ts` pins the behaviour under
"returns 402 for a user already over the cap". If that cap ever moves to a delta check, that test and
the 402 on `/goals/{id}/complete` in api-spec.yml should go with it. The same trap applies to
`routines`, which is why the fix belongs in `private.enforce_plan_limit()` rather than here.

## Backlog

- `GET /goals/backlog` returns **unpromoted** ideas only — api-spec.yml calls them "ideas not yet
  promoted", and `goal_backlog_pending_idx` is the partial index for exactly that query.
- Promotion creates an _active_ goal from the idea (notes become the description, the virtue becomes
  the single tag) and stamps the item with the new goal's id. It does not delete the item;
  `DELETE /goals/backlog/{id}` is how an idea is dismissed.
- `promoteBacklogItem` locks the item **`for update`**. Without it, two clients promoting the same
  idea at once each see a null `promoted_to_goal_id` — neither transaction can see the other's
  uncommitted update — and each creates a goal. The test drives `GoalStorage` directly, because over
  HTTP the two requests stagger and the race never appears.
- Editing a promoted item is a **400**: api-spec.yml scopes the operation to an unpromoted idea and
  sends the caller to `PATCH /goals/{id}`, and gives it no 409 to refuse with.
- `source_id` names a field log or retrospective and is deliberately not a foreign key, so the router
  rejects one sent alongside `source: manual`; nothing else would catch it.

## Deletion is all cascade

Deleting a goal takes its virtue tags and its whole subtask subtree with it. A backlog item promoted
into that goal survives with a null `promoted_to_goal_id` (`on delete set null` scoped to the
column), which makes it promotable again. To keep a goal for the record, `PATCH` it to `archived`.

## Running the tests

They need a real PostgreSQL server and skip themselves when `DATABASE_URL` is unset.

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest --pool=forks run test/api/goal/goals.test.ts
```

Against a stock Postgres container instead of the Supabase stack, add `PATH_DB_MODE=bare`. Shared
scaffolding lives in `test/api/shared/`: `createDbTestApp` (real `Server`, real validator, real
routers) and `seedUser`, whose options set subscription tier and expiry for the 402 cases.
