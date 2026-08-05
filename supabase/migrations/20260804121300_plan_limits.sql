-- Free-tier plan limits.
--
-- Technical design §9 enforces these in Edge Functions. That is not sufficient:
-- §7 also has the React Native client writing to PostgREST directly under RLS,
-- so a client can insert a fifth virtue or an eleventh routine without an Edge
-- Function ever running. The cap has to live where the write lands.
--
-- These are AFTER ... FOR EACH STATEMENT triggers, not BEFORE ... FOR EACH ROW.
-- A row-level trigger cannot see rows inserted earlier in its own statement, so
-- a single multi-row INSERT would slip past every per-row check. A statement
-- trigger with a transition table sees the whole batch.

create or replace function private.enforce_plan_limit()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_limit     constant integer := (tg_argv[0])::integer;
  v_predicate constant text    := coalesce(tg_argv[1], '');
  v_user_id   uuid;
  v_count     integer;
  v_tier      public.subscription_tier;
  v_expires   timestamptz;
begin
  for v_user_id in select distinct n.user_id from affected_rows n loop
    select p.subscription_tier, p.subscription_expires_at
      into v_tier, v_expires
      from public.profiles p
     where p.id = v_user_id;

    -- Premium is unlimited while the subscription is live. A lapsed premium
    -- user keeps their existing rows but cannot add more.
    if v_tier = 'premium' and (v_expires is null or v_expires > now()) then
      continue;
    end if;

    execute format(
      'select count(*) from public.%I where user_id = $1 %s',
      tg_table_name,
      v_predicate
    )
    into v_count
    using v_user_id;

    if v_count > v_limit then
      raise exception
        'free plan allows at most % %', v_limit, tg_table_name
        using
          errcode = 'P0001',
          detail  = format('plan_limit_exceeded:%s:%s', tg_table_name, v_limit),
          hint    = 'Upgrade to premium for unlimited items.';
    end if;
  end loop;

  return null;
end;
$$;

comment on function private.enforce_plan_limit() is
  'Statement-level free-tier cap. tg_argv[0] is the limit, tg_argv[1] an optional extra predicate. Raises P0001 with a plan_limit_exceeded detail for the Edge layer to map to HTTP 402.';

-- Free tier: up to 4 virtues (which is also what signup creates).
drop trigger if exists virtues_plan_limit on public.virtues;
create trigger virtues_plan_limit
  after insert on public.virtues
  referencing new table as affected_rows
  for each statement execute function private.enforce_plan_limit('4');

-- Free tier: up to 10 active routines. Reactivating a routine counts too, so
-- UPDATE is covered as well.
--
-- INSERT and UPDATE need separate triggers: PostgreSQL rejects a transition
-- table on a trigger declared for more than one event.
drop trigger if exists routines_plan_limit_insert on public.routines;
create trigger routines_plan_limit_insert
  after insert on public.routines
  referencing new table as affected_rows
  for each statement execute function private.enforce_plan_limit('10', 'and is_active');

drop trigger if exists routines_plan_limit_update on public.routines;
create trigger routines_plan_limit_update
  after update on public.routines
  referencing new table as affected_rows
  for each statement execute function private.enforce_plan_limit('10', 'and is_active');

-- Free tier: up to 3 active goals. Promoting a backlog item to active is an
-- UPDATE, which is the most likely way to cross this line.
drop trigger if exists goals_plan_limit_insert on public.goals;
create trigger goals_plan_limit_insert
  after insert on public.goals
  referencing new table as affected_rows
  for each statement execute function private.enforce_plan_limit('3', 'and status = ''active''');

drop trigger if exists goals_plan_limit_update on public.goals;
create trigger goals_plan_limit_update
  after update on public.goals
  referencing new table as affected_rows
  for each statement execute function private.enforce_plan_limit('3', 'and status = ''active''');
