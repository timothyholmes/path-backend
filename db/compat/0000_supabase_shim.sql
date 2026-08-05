-- Supabase compatibility shim for a bare PostgreSQL server.
--
-- Applied by db/migrate.ts only when PATH_DB_MODE=bare, and never against a
-- real Supabase database, where all of this already exists and is managed by
-- the platform.
--
-- The point is that supabase/migrations/*.sql stays completely unmodified:
-- the same SQL that runs in production also runs on a stock postgres:17
-- container in CI, with no Docker-in-Docker and no Supabase stack.
--
-- This is a test double, not an auth system. It creates just enough of the
-- Supabase surface for the migrations and the RLS policies to be exercised:
-- the auth schema, the JWT accessor functions, and the three PostgREST roles.

create schema if not exists auth;
create schema if not exists extensions;

-- Supabase's PostgREST roles. `authenticator` is the login role that PostgREST
-- connects as before switching into one of the other three.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- Matches Supabase: the service role bypasses RLS entirely.
    create role service_role nologin noinherit bypassrls;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password 'postgres';
  end if;
end
$$;

grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

-- Minimal stand-in for Supabase Auth's user table. Only the columns the
-- application actually reads are modelled; the signup trigger in
-- 20260804120300_profiles_virtues.sql reads id, email, and raw_user_meta_data.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              varchar(255) unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Mirrors Supabase's own implementation, including the legacy
-- request.jwt.claim.sub fallback, so policies behave identically in both modes.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    ),
    ''
  )::text;
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.email', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
    ),
    ''
  )::text;
$$;
