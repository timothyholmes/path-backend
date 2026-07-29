# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # Start with hot reload (ts-node + nodemon)
npm run build          # Compile TypeScript to dist/
npm start               # Run compiled output
npm test                # Run all tests (vitest, fork pool)
npm run test:watch     # Watch mode
npm run lint            # Lint (eslint .)
npm run lint:fix       # Lint and auto-fix
npm run format          # Format the repo with Prettier
npm run format:check   # Check formatting without writing
```

Run a single test file:

```bash
npx vitest --pool=forks run test/routes/reservations.test.ts
```

## Architecture

Express 5 + TypeScript backend for a room reservations API. The OpenAPI spec (`api-spec.yml`) is the source of truth — `express-openapi-validator` enforces request/response validation against it at runtime, and Swagger UI is served at `/docs`. Any new endpoint or field must be added to `api-spec.yml` or requests/responses will fail validation.

**Wiring pattern** — `Server` is a generic builder class (`src/server.ts`), parameterized by `Config` and `Dependencies`, that chains:

1. `.withOpenApiSpec(path)` — mounts the validator + Swagger UI
2. `.withDependencies(getDependencies, overrides?)` — instantiates services/storage; `overrides` allow test injection
3. `.withRouters(getRouters)` — mounts route handlers and registers the global error handler (must run last; throws if dependencies aren't set yet)

`src/index.ts` assembles the real server; `test/helpers.ts:createTestApp()` assembles an identical stack for tests, wrapped in `supertest`.

**Config loading** (`src/config.ts`) — `ConfigLoader` reads `config/default.yml`, deep-merges it with `config/{NODE_ENV}.yml` (defaults to `development`), then walks the merged object decrypting any string values of the form `ENC(iv:authTag:ciphertext)` using AES-256-GCM with a key from `CONFIG_ENCRYPTION_KEY` (64-char hex env var). Encrypt new secrets with `scripts/encrypt-secret.ts` and paste the resulting `ENC(...)` value into the relevant `config/*.yml` — never commit plaintext secrets. `config/secrets.yml` is gitignored for local-only overrides.

**Resource pattern (Router → Service → Storage)** — The Reservation/Availability code is a worked example of the layering every resource follows; new resources should be added the same way, not as one-off code:

- **Router** (e.g. `src/api/ReservationRouter.ts`) — a class taking `(config, dependencies)` in its constructor, with one method per HTTP verb, bound into `express.Router` inside `src/routers.ts` (e.g. `reservation.create.bind(reservation)`). Handles only things the OpenAPI schema can't express (e.g. `endTime > startTime`) by throwing a `ServerError` subclass, then delegates to a service and maps the result to a status code.
- **Service** (e.g. `src/api/ReservationService.ts`) — business logic: id generation (`uuid`), CRUD, and cursor-paginated search. Throws `NotFound`/`Conflict`/`ServerError` for domain failures; a service only depends on the storage/services it's given via `Pick<Dependencies, ...>`, not the full `Dependencies` object.
- **Storage** (e.g. `src/api/ReservationStorage.ts`) — a thin wrapper around an in-memory `Map`, implementing `Symbol.iterator` so other services can scan the underlying data without reaching into internals (this is how `AvailabilityService` derives room availability from `ReservationStorage` without its own storage).

**Dependency graph** (`src/dependencies.ts`): `getDependencies` builds `ReservationStorage`, then `ReservationService` and `AvailabilityService` on top of it (both share the one storage instance), threading `overrides` through at each step for test injection.

**Error handling** (`src/errors/`): `ServerError` is the base class (`message`, HTTP `code`, `type` string, optional wrapped `originalError`); `NotFound`, `BadRequest`, and `Conflict` are prebuilt subclasses pinned to their status/reason phrase (`http-status-codes`) — reach for these (or add a new subclass the same way) rather than throwing raw errors. The global handler registered in `Server.withRouters` catches `ServerError` instances and formats `{ error, message }` JSON; `express-openapi-validator` schema-violation errors (shaped `{ status, message }`) flow through the same handler.

**Tests** use `supertest` against a real `Server` instance — no mocks. `test/fixtures.ts` provides a shared six-reservation dataset plus a `seed()` helper.

**Storage**
Database is completely in memory by design. Do not add any persistence. It is acceptable to lose data between restarts.

## Key conventions

- Times are epoch milliseconds (`startTime`, `endTime`)
- Pagination uses opaque string cursors (the last item's id); `limit` is query-param-driven, default 500
- `PORT` is read from `process.env.PORT`, defaulting to 3000
- 2-space indentation, single quotes, semicolons, trailing commas — enforced by ESLint (`eslint.config.mjs`, flat config, `typescript-eslint` recommended rules) and Prettier; run `npm run lint` / `npm run format` before committing
