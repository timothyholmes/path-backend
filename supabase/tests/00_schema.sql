-- Structural guarantees: the things every other test quietly depends on.
begin;
create extension if not exists pgtap with schema extensions;

select plan(24);

-- Tables exist.
select has_table('public', 'profiles', 'profiles exists');
select has_table('public', 'virtues', 'virtues exists');
select has_table('public', 'routines', 'routines exists');
select has_table('public', 'routine_completions', 'routine_completions exists');
select has_table('public', 'goals', 'goals exists');
select has_table('public', 'sessions', 'sessions exists');
select has_table('public', 'session_instances', 'session_instances exists');
select has_table('public', 'field_logs', 'field_logs exists');
select has_table('public', 'retrospectives', 'retrospectives exists');
select has_table('public', 'xp_ledger', 'xp_ledger exists');
select has_table('public', 'daily_activity', 'daily_activity exists');

-- RLS is on everywhere it matters. A table added later without RLS is the
-- single most likely way to leak data, so this is asserted per table rather
-- than assumed.
select results_eq(
  $$ select count(*)::integer
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and not c.relrowsecurity $$,
  $$ values (0) $$,
  'every table in public has row level security enabled'
);

-- The ledger is partitioned, not a plain table.
select results_eq(
  $$ select relkind::text from pg_class where relname = 'xp_ledger' $$,
  $$ values ('p') $$,
  'xp_ledger is a partitioned table'
);

-- Partitions must stay out of the PostgREST-exposed schema.
select results_eq(
  $$ select count(*)::integer
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_inherits i on i.inhrelid = c.oid
      where i.inhparent = 'public.xp_ledger'::regclass
        and n.nspname <> 'private' $$,
  $$ values (0) $$,
  'all xp_ledger partitions live in the private schema'
);

-- Functions the Edge layer calls by name.
select has_function('public', 'calculate_and_award_xp', 'scoring function exists');
select has_function('public', 'recalculate_streak', 'streak function exists');
select has_function('public', 'level_for_xp', 'level lookup exists');
select has_function('public', 'xp_for_level', 'xp curve exists');

-- Enum values must match api-spec.yml exactly or generated types drift.
select results_eq(
  $$ select unnest(enum_range(null::public.subscription_tier))::text order by 1 $$,
  $$ values ('free'), ('premium') $$,
  'subscription_tier matches the API contract'
);

select results_eq(
  $$ select unnest(enum_range(null::public.xp_source_type))::text order by 1 $$,
  $$ values ('bonus'), ('goal'), ('penalty'), ('retrospective'), ('routine'), ('session') $$,
  'xp_source_type matches the API contract'
);

select results_eq(
  $$ select unnest(enum_range(null::public.goal_status))::text order by 1 $$,
  $$ values ('active'), ('archived'), ('backlog'), ('completed') $$,
  'goal_status matches the API contract'
);

select results_eq(
  $$ select unnest(enum_range(null::public.session_instance_status))::text order by 1 $$,
  $$ values ('completed'), ('in_progress'), ('scheduled'), ('skipped') $$,
  'session_instance_status matches the API contract'
);

select results_eq(
  $$ select unnest(enum_range(null::public.retro_status))::text order by 1 $$,
  $$ values ('generated'), ('reviewed'), ('skipped') $$,
  'retro_status matches the API contract'
);

-- SECURITY DEFINER functions must pin search_path, or a caller can shadow the
-- objects they resolve and run arbitrary code as the owner.
select results_eq(
  $$ select count(*)::integer
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and p.prosecdef
        and (p.proconfig is null
             or not exists (
               select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%'
             )) $$,
  $$ values (0) $$,
  'every SECURITY DEFINER function pins its search_path'
);

select * from finish();
rollback;
