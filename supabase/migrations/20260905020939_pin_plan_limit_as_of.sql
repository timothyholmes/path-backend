-- enforce_plan_limit() decided whether a premium subscription was still live by
-- comparing subscription_expires_at to the database's real now(). Triggers fire
-- implicitly on INSERT/UPDATE, so unlike recalculate_streak() (see
-- 20260902012409_add_streak_as_of.sql) there is no call-site argument to pin --
-- the seeder can only reach the trigger through a session/transaction-local
-- setting. Read one here, defaulting to real now() so production behaviour is
-- unchanged; the seeder sets it for the duration of its transaction so a
-- "still live while the premium-sized dataset is written" fixture (edge-cases'
-- lapsed-premium user) stays live relative to the scenario's asOf rather than
-- rotting as real wall-clock time passes it.
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
  v_now       constant timestamptz :=
    coalesce(nullif(current_setting('path.seed_as_of', true), '')::timestamptz, now());
begin
  for v_user_id in select distinct n.user_id from affected_rows n loop
    select p.subscription_tier, p.subscription_expires_at
      into v_tier, v_expires
      from public.profiles p
     where p.id = v_user_id;

    -- Premium is unlimited while the subscription is live. A lapsed premium
    -- user keeps their existing rows but cannot add more.
    if v_tier = 'premium' and (v_expires is null or v_expires > v_now) then
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
  'Statement-level free-tier cap. tg_argv[0] is the limit, tg_argv[1] an optional extra predicate. Raises P0001 with a plan_limit_exceeded detail for the Edge layer to map to HTTP 402. Honors the path.seed_as_of setting (see db/seed) in place of now() when deciding whether a premium subscription is still live.';
