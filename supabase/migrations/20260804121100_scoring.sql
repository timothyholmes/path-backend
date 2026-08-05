-- Scoring engine.
--
-- Technical design §4 puts XP calculation, streak math, and multiplier logic in
-- the database so completions are transactional and free of read-modify-write
-- races. Everything below is called from Edge Functions via RPC.
--
-- Three corrections to the function sketched in the design doc:
--
--   1. array_length() on an empty array returns NULL, not 0, which made the
--      virtue bonus (and every value derived from it) NULL. The ledger
--      explicitly allows a null virtue_id for global-only XP, so the empty case
--      is reachable. Handled with coalesce().
--   2. floor(final_xp / virtue_count) silently discards the remainder, so
--      global_xp would drift away from sum(virtue.xp) permanently. The
--      remainder is now distributed deterministically by display_order.
--   3. Multipliers are not applied to negative base XP: a skip penalty should
--      not be amplified by a long streak.

create or replace function public.calculate_and_award_xp(
  p_user_id     uuid,
  p_source_type public.xp_source_type,
  p_source_id   uuid,
  p_base_xp     integer,
  p_virtue_ids  uuid[] default '{}'::uuid[],
  p_description varchar(300) default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_now            timestamptz := now();
  v_virtue_count   integer;
  v_matched_count  integer;
  v_streak_mult    numeric(3, 2);
  v_virtue_bonus   numeric(4, 2);
  v_combined       numeric(5, 3);
  v_final_xp       integer;
  v_per_virtue     integer;
  v_remainder      integer;
  v_timezone       text;
  v_local_date     date;
  v_global_xp      integer;
  v_global_level   integer;
  v_current_streak integer;
  v_ledger_ids     uuid[];
begin
  -- SECURITY DEFINER means this runs with the owner's rights and bypasses RLS,
  -- so it must police its own caller. A request carrying a user JWT may only
  -- award XP to that user; service_role and superuser calls have no auth.uid()
  -- and are trusted.
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'cannot award XP to another user'
      using errcode = '42501';
  end if;

  if p_base_xp is null then
    raise exception 'p_base_xp is required' using errcode = '22004';
  end if;

  v_virtue_count := coalesce(array_length(p_virtue_ids, 1), 0);

  -- Serialises concurrent completions for this user, so global_xp cannot be
  -- lost to a read-modify-write race.
  select p.streak_multiplier, p.timezone
    into v_streak_mult, v_timezone
    from public.profiles p
   where p.id = p_user_id
     for update;

  if not found then
    raise exception 'no profile for user %', p_user_id using errcode = '23503';
  end if;

  -- Every virtue must exist and belong to this user. A mismatch would silently
  -- drop XP (fewer rows than expected) and lets a caller probe other users' ids.
  -- Duplicates in the array also fail here, which is intended: they would
  -- otherwise inflate the multi-virtue bonus.
  if v_virtue_count > 0 then
    select count(*)
      into v_matched_count
      from public.virtues v
     where v.user_id = p_user_id
       and v.id = any (p_virtue_ids);

    if v_matched_count <> v_virtue_count then
      raise exception 'virtue ids must be distinct and belong to user %', p_user_id
        using errcode = '23503';
    end if;
  end if;

  if p_base_xp < 0 then
    v_streak_mult  := 1.00;
    v_virtue_bonus := 1.00;
  else
    v_virtue_bonus := 1.0 + (0.10 * greatest(v_virtue_count - 1, 0));
  end if;

  v_combined := round(v_streak_mult * v_virtue_bonus, 3);
  v_final_xp := floor(p_base_xp * v_streak_mult * v_virtue_bonus)::integer;

  if v_virtue_count > 0 then
    -- Integer division truncates toward zero, so the remainder carries the sign
    -- of v_final_xp and the distribution below stays correct for penalties.
    v_per_virtue := v_final_xp / v_virtue_count;
    v_remainder  := v_final_xp - (v_per_virtue * v_virtue_count);
  else
    v_per_virtue := 0;
    v_remainder  := 0;
  end if;

  if v_virtue_count = 0 then
    insert into public.xp_ledger (
      user_id, virtue_id, source_type, source_id,
      base_xp, multiplier, final_xp, description, created_at
    )
    values (
      p_user_id, null, p_source_type, p_source_id,
      p_base_xp, v_combined, v_final_xp, p_description, v_now
    )
    returning array[id] into v_ledger_ids;
  else
    with ordered as (
      select
        v.id,
        (row_number() over (order by v.display_order, v.id))::integer as rn
      from public.virtues v
      where v.user_id = p_user_id
        and v.id = any (p_virtue_ids)
    ),
    allocated as (
      select
        o.id,
        v_per_virtue
          + case
              when o.rn <= abs(v_remainder) then sign(v_remainder)::integer
              else 0
            end as xp
      from ordered o
    ),
    inserted as (
      insert into public.xp_ledger (
        user_id, virtue_id, source_type, source_id,
        base_xp, multiplier, final_xp, description, created_at
      )
      select
        p_user_id, a.id, p_source_type, p_source_id,
        p_base_xp, v_combined, a.xp, p_description, v_now
      from allocated a
      returning id
    ),
    -- Data-modifying CTEs always run to completion whether or not the outer
    -- query reads them, so this applies even though only `inserted` is selected.
    bumped as (
      update public.virtues v
         set xp    = v.xp + a.xp,
             level = public.level_for_xp(v.xp + a.xp)
        from allocated a
       where v.id = a.id
      returning v.id
    )
    select array_agg(i.id) into v_ledger_ids from inserted i;
  end if;

  update public.profiles p
     set global_xp      = p.global_xp + v_final_xp,
         global_level   = public.level_for_xp(p.global_xp + v_final_xp),
         last_active_at = greatest(coalesce(p.last_active_at, v_now), v_now)
   where p.id = p_user_id
  returning p.global_xp, p.global_level, p.current_streak
       into v_global_xp, v_global_level, v_current_streak;

  v_local_date := (v_now at time zone v_timezone)::date;

  -- A penalty reduces the day's earnings without counting as activity, so it
  -- cannot keep a streak alive on its own (technical design §4).
  insert into public.daily_activity (user_id, activity_date, completion_count, xp_earned)
  values (
    p_user_id,
    v_local_date,
    case when p_base_xp > 0 then 1 else 0 end,
    v_final_xp
  )
  on conflict (user_id, activity_date) do update
    set completion_count = daily_activity.completion_count + excluded.completion_count,
        xp_earned        = daily_activity.xp_earned + excluded.xp_earned;

  return jsonb_build_object(
    'xp_earned',         v_final_xp,
    'base_xp',           p_base_xp,
    'streak_multiplier', v_streak_mult,
    'virtue_bonus',      v_virtue_bonus,
    'per_virtue_xp',     v_per_virtue,
    'global_xp',         v_global_xp,
    'global_level',      v_global_level,
    'current_streak',    v_current_streak,
    'ledger_entry_ids',  to_jsonb(coalesce(v_ledger_ids, '{}'::uuid[]))
  );
end;
$$;

comment on function public.calculate_and_award_xp is
  'Awards XP for a completion. Returns a payload matching the ScoringResult schema in api-spec.yml.';

comment on column public.xp_ledger.base_xp is
  'Base XP of the awarding event, repeated on each per-virtue row. final_xp is the authoritative per-row amount.';

-- Recomputes the streak from daily_activity in the user's own timezone.
-- A streak survives until the end of the following local day, so a user who has
-- not acted *yet today* keeps yesterday's streak.
create or replace function public.recalculate_streak(p_user_id uuid)
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

  v_today := (now() at time zone v_timezone)::date;

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

comment on function public.recalculate_streak(uuid) is
  'Recomputes current_streak, longest_streak, and streak_multiplier from daily_activity in the user''s timezone.';

-- Hourly cron entry point. Processes only users whose local date has advanced
-- past the last recalculation, which makes one hourly job correct for every
-- timezone and idempotent if a run is missed.
create or replace function private.recalculate_due_streaks()
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user_id uuid;
  v_count   integer := 0;
begin
  for v_user_id in
    select p.id
      from public.profiles p
     where p.streak_calculated_on is null
        or p.streak_calculated_on < (now() at time zone p.timezone)::date
  loop
    perform public.recalculate_streak(v_user_id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Scoring is reachable by signed-in users (policed by the auth.uid() check
-- above) and by the service role. Nothing else.
revoke all on function public.calculate_and_award_xp(uuid, public.xp_source_type, uuid, integer, uuid[], varchar) from public;
grant execute on function public.calculate_and_award_xp(uuid, public.xp_source_type, uuid, integer, uuid[], varchar) to authenticated, service_role;

revoke all on function public.recalculate_streak(uuid) from public;
grant execute on function public.recalculate_streak(uuid) to authenticated, service_role;

revoke all on function private.recalculate_due_streaks() from public;
