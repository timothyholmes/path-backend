-- The streak engine.
--
-- Streaks are computed in the user's own timezone from the daily_activity
-- rollup, which is why every fixture below writes local dates rather than
-- timestamps.
begin;
create extension if not exists pgtap with schema extensions;

select plan(13);

insert into auth.users (id, email, raw_user_meta_data)
values
  ('11110000-0000-4000-8000-000000000011', 'streak@test',  '{"timezone":"UTC"}'),
  ('22220000-0000-4000-8000-000000000022', 'nz@test',      '{"timezone":"Pacific/Auckland"}');

-- A five-day run ending today, and an older run separated by a gap. Only the
-- current run counts toward current_streak.
insert into public.daily_activity (user_id, activity_date, completion_count, xp_earned)
select '11110000-0000-4000-8000-000000000011', current_date - g, 1, 10
from generate_series(0, 4) g;

insert into public.daily_activity (user_id, activity_date, completion_count, xp_earned)
select '11110000-0000-4000-8000-000000000011', current_date - g, 1, 10
from generate_series(10, 16) g;

select is(
  public.recalculate_streak('11110000-0000-4000-8000-000000000011'),
  5,
  'the current run is five days, not the whole history'
);

select is(
  (select streak_multiplier from public.profiles where id = '11110000-0000-4000-8000-000000000011'),
  1.25::numeric(3,2),
  'a five-day streak gives a 1.25x multiplier'
);

-- The older seven-day run is the all-time best and must be recorded even though
-- no recalculation happened while it was live.
select is(
  (select longest_streak from public.profiles where id = '11110000-0000-4000-8000-000000000011'),
  7,
  'longest_streak is derived from full history, not just the current run'
);

-- A day with no completions does not extend a run, even if XP moved that day.
insert into public.daily_activity (user_id, activity_date, completion_count, xp_earned)
values ('11110000-0000-4000-8000-000000000011', current_date - 5, 0, -25);

select is(
  public.recalculate_streak('11110000-0000-4000-8000-000000000011'),
  5,
  'a zero-completion day does not bridge a gap'
);

-- The grace rule: a user who has not acted yet today keeps yesterday's streak.
delete from public.daily_activity
 where user_id = '11110000-0000-4000-8000-000000000011' and activity_date = current_date;

select is(
  public.recalculate_streak('11110000-0000-4000-8000-000000000011'),
  4,
  'a streak survives until the end of the following local day'
);

-- Two idle days ends it.
delete from public.daily_activity
 where user_id = '11110000-0000-4000-8000-000000000011' and activity_date = current_date - 1;

select is(
  public.recalculate_streak('11110000-0000-4000-8000-000000000011'),
  0,
  'two idle days breaks the streak'
);

select is(
  (select streak_multiplier from public.profiles where id = '11110000-0000-4000-8000-000000000011'),
  1.00::numeric(3,2),
  'a broken streak resets the multiplier to 1.0'
);

select is(
  (select longest_streak from public.profiles where id = '11110000-0000-4000-8000-000000000011'),
  7,
  'longest_streak survives the reset'
);

-- ------------------------------------------------------------- multiplier cap
insert into public.daily_activity (user_id, activity_date, completion_count, xp_earned)
select '22220000-0000-4000-8000-000000000022',
       (now() at time zone 'Pacific/Auckland')::date - g, 1, 10
from generate_series(0, 29) g;

select is(
  public.recalculate_streak('22220000-0000-4000-8000-000000000022'),
  30,
  'a 30-day run is counted in full'
);

select is(
  (select streak_multiplier from public.profiles where id = '22220000-0000-4000-8000-000000000022'),
  2.00::numeric(3,2),
  'the multiplier caps at 2.0 rather than climbing to 2.5'
);

-- The recalculation stamp is the user's local date, which is what makes one
-- hourly cron job correct for every timezone.
select is(
  (select streak_calculated_on from public.profiles where id = '22220000-0000-4000-8000-000000000022'),
  (now() at time zone 'Pacific/Auckland')::date,
  'streak_calculated_on records the user local date, not the UTC date'
);

-- ------------------------------------------------------------- the cron entry
-- Scoped to this test's users: supabase/seed.sql creates a developer account
-- that is present in every reset database.
select is(
  (select count(*)::integer from public.profiles
    where id in ('11110000-0000-4000-8000-000000000011', '22220000-0000-4000-8000-000000000022')
      and (streak_calculated_on is null
           or streak_calculated_on < (now() at time zone timezone)::date)),
  0,
  'no user is left due after both recalculations'
);

update public.profiles set streak_calculated_on = null
 where id in ('11110000-0000-4000-8000-000000000011', '22220000-0000-4000-8000-000000000022');

select ok(
  private.recalculate_due_streaks() >= 2,
  'the hourly job picks up every user whose local date has advanced'
);

select * from finish();
rollback;
