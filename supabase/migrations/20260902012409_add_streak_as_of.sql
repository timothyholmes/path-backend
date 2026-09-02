-- recalculate_streak() derived "today" from the database's real now(), which
-- made it impossible to pin a deterministic "today" for seeding/test fixtures:
-- any fixture built around a fixed calendar date silently rots as real wall
-- clock time drifts past it. Add an optional p_as_of override (defaulting to
-- null, i.e. the existing now()-based behaviour) so callers that need a fixed
-- point in time -- the seeder in particular -- can supply one explicitly.
--
-- CREATE OR REPLACE cannot widen a parameter list in place -- it creates a
-- second overload rather than replacing the original, which leaves any 1-arg
-- call ambiguous between the two. Drop the old signature explicitly first.
drop function if exists public.recalculate_streak(uuid);

create function public.recalculate_streak(p_user_id uuid, p_as_of timestamptz default null)
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_timezone   text;
  v_today      date;
  v_last       date;
  v_streak     integer := 0;
  v_longest    integer := 0;
  v_multiplier numeric(3, 2);
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'cannot recalculate another user''s streak'
      using errcode = '42501';
  end if;

  select p.timezone into v_timezone
    from public.profiles p
   where p.id = p_user_id
     for update;

  if not found then
    raise exception 'no profile for user %', p_user_id using errcode = '23503';
  end if;

  v_today := (coalesce(p_as_of, now()) at time zone v_timezone)::date;

  select max(d.activity_date)
    into v_last
    from public.daily_activity d
   where d.user_id = p_user_id
     and d.completion_count > 0
     and d.activity_date <= v_today;

  if v_last is not null and v_last >= v_today - 1 then
    -- Consecutive-run detection: ordering active days descending and adding the
    -- row number yields a constant for every day in an unbroken run. The run
    -- containing the most recent active day has key v_last + 1.
    select count(*)
      into v_streak
      from (
        select
          d.activity_date
            + (row_number() over (order by d.activity_date desc))::integer as run_key
        from public.daily_activity d
        where d.user_id = p_user_id
          and d.completion_count > 0
          and d.activity_date <= v_today
      ) runs
     where runs.run_key = v_last + 1;
  end if;

  -- longest_streak is derived from the full history rather than only from the
  -- run in progress. Carrying it forward from the previous value would mean a
  -- past best is recorded only if a recalculation happened to land while that
  -- run was live -- so a missed cron run, or history imported after the fact,
  -- would silently understate it.
  select coalesce(max(runs.run_length), 0)
    into v_longest
    from (
      select count(*) as run_length
        from (
          select
            d.activity_date
              + (row_number() over (order by d.activity_date desc))::integer as run_key
          from public.daily_activity d
          where d.user_id = p_user_id
            and d.completion_count > 0
        ) keyed
       group by keyed.run_key
    ) runs;

  -- multiplier = min(1.0 + streak_days * 0.05, 2.0), capped at 2.0 (§4).
  v_multiplier := least(1.00 + (v_streak * 0.05), 2.00);

  update public.profiles p
     set current_streak       = v_streak,
         longest_streak       = greatest(p.longest_streak, v_streak, v_longest),
         streak_multiplier    = v_multiplier,
         streak_calculated_on = v_today
   where p.id = p_user_id;

  return v_streak;
end;
$$;

comment on function public.recalculate_streak(uuid, timestamptz) is
  'Recomputes current_streak, longest_streak, and streak_multiplier from daily_activity in the user''s timezone. p_as_of overrides "now" (used by seeding/tests to pin a deterministic date); production callers omit it.';

revoke all on function public.recalculate_streak(uuid, timestamptz) from public;
grant execute on function public.recalculate_streak(uuid, timestamptz) to authenticated, service_role;
