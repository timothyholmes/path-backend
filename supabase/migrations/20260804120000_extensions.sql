-- Foundational schema objects.
--
-- `private` holds everything that must never be reachable through PostgREST:
-- trigger functions, partition management, and the xp_ledger partitions
-- themselves. `[api] schemas` in supabase/config.toml exposes only `public`,
-- so nothing in here is addressable over HTTP.

create schema if not exists private;

comment on schema private is
  'Internal objects never exposed through PostgREST: trigger helpers, partition management, xp_ledger partitions.';

revoke all on schema private from public;

-- gen_random_uuid() is built into PostgreSQL 13+, so no pgcrypto dependency is
-- needed for primary keys. pg_cron is handled in the cron migration, where its
-- availability is checked first (it ships with Supabase but not stock Postgres).
