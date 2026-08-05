-- Row Level Security.
--
-- Technical design §2: every table is isolated at the database level, so a bug
-- in an Edge Function cannot leak data across users. The React Native client is
-- also allowed to query PostgREST directly, which makes these policies the real
-- boundary rather than a second line of defence.
--
-- The policies are generated from a table list rather than written out fifteen
-- times. Every user-scoped table has an identical shape -- a denormalised
-- user_id -- and uniformity is the property that matters most here: a typo in
-- one of sixty hand-written policies is both easy to make and hard to see.
-- Tables that do not follow the pattern are handled explicitly below.

do $$
declare
  v_table text;
  v_user_scoped constant text[] := array[
    'virtues',
    'routines',
    'routine_virtues',
    'routine_completions',
    'goals',
    'goal_virtues',
    'goal_backlog',
    'sessions',
    'session_virtues',
    'session_instances',
    'field_log_templates',
    'field_logs',
    'field_log_virtues',
    'retrospectives'
  ];
begin
  foreach v_table in array v_user_scoped loop
    execute format('alter table public.%I enable row level security', v_table);

    execute format('drop policy if exists %I on public.%I', v_table || '_select_own', v_table);
    execute format(
      'create policy %I on public.%I for select to authenticated using (auth.uid() = user_id)',
      v_table || '_select_own', v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_insert_own', v_table);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (auth.uid() = user_id)',
      v_table || '_insert_own', v_table
    );

    -- USING gates which rows are visible to update; WITH CHECK stops a row from
    -- being reassigned to another user on the way out.
    execute format('drop policy if exists %I on public.%I', v_table || '_update_own', v_table);
    execute format(
      'create policy %I on public.%I for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      v_table || '_update_own', v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_delete_own', v_table);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (auth.uid() = user_id)',
      v_table || '_delete_own', v_table
    );

    execute format('revoke all on public.%I from anon', v_table);
    execute format('grant select, insert, update, delete on public.%I to authenticated', v_table);
  end loop;
end
$$;

-- profiles: keyed on id, not user_id. Rows are created by the auth signup
-- trigger and removed by the auth.users cascade, so clients get no insert or
-- delete path.
alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select to authenticated
  using (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- The policy decides which rows; the column grants decide which columns. A
-- client that could write arbitrary profile columns could hand itself premium
-- or set its own XP, so subscription and scoring columns stay service-role only.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, timezone) on public.profiles to authenticated;

-- xp_ledger is append-only and written solely by calculate_and_award_xp().
alter table public.xp_ledger enable row level security;

drop policy if exists xp_ledger_select_own on public.xp_ledger;
create policy xp_ledger_select_own
  on public.xp_ledger for select to authenticated
  using (auth.uid() = user_id);

revoke all on public.xp_ledger from anon;
grant select on public.xp_ledger to authenticated;

-- daily_activity is a derived rollup; clients read it, the scoring function
-- maintains it.
alter table public.daily_activity enable row level security;

drop policy if exists daily_activity_select_own on public.daily_activity;
create policy daily_activity_select_own
  on public.daily_activity for select to authenticated
  using (auth.uid() = user_id);

revoke all on public.daily_activity from anon;
grant select on public.daily_activity to authenticated;

-- Reference data.
revoke all on public.level_thresholds from anon, authenticated;
grant select on public.level_thresholds to anon, authenticated;
