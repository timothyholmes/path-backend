-- Constraints, partition routing, and the composite-FK ownership guarantee.
begin;
create extension if not exists pgtap with schema extensions;

select plan(15);

insert into auth.users (id, email, raw_user_meta_data)
values
  ('c0000000-0000-4000-8000-0000000000c0', 'cons@test',  '{"timezone":"America/New_York"}'),
  ('c1000000-0000-4000-8000-0000000000c1', 'other@test', '{"timezone":"UTC"}');

insert into public.routines (id, user_id, title, frequency)
values ('cc000000-0000-4000-8000-0000000000cc', 'c0000000-0000-4000-8000-0000000000c0', 'Daily', 'daily');

-- --------------------------------------------------- idempotent completion
-- One-tap completion is trivially double-fired by a mobile client on a flaky
-- connection; the second attempt must not award XP twice.
insert into public.routine_completions (routine_id, user_id, completed_at)
values ('cc000000-0000-4000-8000-0000000000cc', 'c0000000-0000-4000-8000-0000000000c0', now());

select throws_ok(
  $$ insert into public.routine_completions (routine_id, user_id, completed_at)
     values ('cc000000-0000-4000-8000-0000000000cc', 'c0000000-0000-4000-8000-0000000000c0', now()) $$,
  '23505',
  null,
  'a routine cannot be completed twice on the same local day'
);

-- completed_on is derived from the user's timezone, never supplied.
select is(
  (select completed_on from public.routine_completions
    where routine_id = 'cc000000-0000-4000-8000-0000000000cc'),
  (now() at time zone 'America/New_York')::date,
  'completed_on is the user local date, not the UTC date'
);

-- Same instant, different local day: allowed, because it is a different day for
-- this user.
select lives_ok(
  $$ insert into public.routine_completions (routine_id, user_id, completed_at)
     values ('cc000000-0000-4000-8000-0000000000cc', 'c0000000-0000-4000-8000-0000000000c0',
             now() - interval '2 days') $$,
  'the same routine can be completed on a different local day'
);

-- ------------------------------------------------- cross-user tagging denied
-- The composite FK makes "my routine tagged with your virtue" unrepresentable,
-- rather than merely discouraged.
select throws_ok(
  $$ insert into public.routine_virtues (routine_id, virtue_id, user_id)
     values ('cc000000-0000-4000-8000-0000000000cc',
             (select id from public.virtues where user_id = 'c1000000-0000-4000-8000-0000000000c1' limit 1),
             'c0000000-0000-4000-8000-0000000000c0') $$,
  '23503',
  null,
  'a routine cannot be tagged with another user''s virtue'
);

-- --------------------------------------------------------------- routines
select throws_ok(
  $$ insert into public.routines (user_id, title, frequency, scheduled_day)
     values ('c0000000-0000-4000-8000-0000000000c0', 'Bad weekly', 'weekly', 9) $$,
  '23514',
  null,
  'a weekly routine cannot be scheduled on day 9'
);

select throws_ok(
  $$ insert into public.routines (user_id, title, frequency, scheduled_day)
     values ('c0000000-0000-4000-8000-0000000000c0', 'Bad daily', 'daily', 3) $$,
  '23514',
  null,
  'a daily routine cannot carry a scheduled day'
);

-- base_xp defaults by frequency, which a column default cannot express.
insert into public.routines (id, user_id, title, frequency, scheduled_day)
values ('cd000000-0000-4000-8000-0000000000cd', 'c0000000-0000-4000-8000-0000000000c0', 'Weekly', 'weekly', 6);

select is(
  (select base_xp from public.routines where id = 'cd000000-0000-4000-8000-0000000000cd'),
  25,
  'a weekly routine defaults to 25 base XP'
);

-- ------------------------------------------------------------------- goals
select throws_ok(
  $$ insert into public.goals (user_id, title, status, completed_at)
     values ('c0000000-0000-4000-8000-0000000000c0', 'Inconsistent', 'completed', null) $$,
  '23514',
  null,
  'a completed goal must have a completion timestamp'
);

select throws_ok(
  $$ insert into public.goals (user_id, title, status, completed_at)
     values ('c0000000-0000-4000-8000-0000000000c0', 'Also wrong', 'active', now()) $$,
  '23514',
  null,
  'an active goal cannot carry a completion timestamp'
);

-- ---------------------------------------------------------------- profiles
select throws_ok(
  $$ update public.profiles set timezone = 'Mars/Olympus_Mons'
      where id = 'c0000000-0000-4000-8000-0000000000c0' $$,
  '22023',
  null,
  'an invalid IANA timezone is rejected before it can break streaks'
);

-- ---------------------------------------------------------- retrospectives
insert into public.retrospectives (user_id, period_type, period_start, period_end)
values ('c0000000-0000-4000-8000-0000000000c0', 'weekly', current_date - 7, current_date - 1);

select throws_ok(
  $$ insert into public.retrospectives (user_id, period_type, period_start, period_end)
     values ('c0000000-0000-4000-8000-0000000000c0', 'weekly', current_date - 7, current_date - 1) $$,
  '23505',
  null,
  'a user gets at most one retrospective per period'
);

select throws_ok(
  $$ insert into public.retrospectives (user_id, period_type, period_start, period_end)
     values ('c0000000-0000-4000-8000-0000000000c0', 'monthly', current_date, current_date - 30) $$,
  '23514',
  null,
  'a retrospective period cannot end before it starts'
);

-- Unbounded JSONB growth on a hot row is the failure mode the cap prevents.
select throws_ok(
  $$ update public.retrospectives
        set chat_history = (
          select jsonb_agg(jsonb_build_object('role', 'user', 'content', g::text))
          from generate_series(1, 50) g)
      where user_id = 'c0000000-0000-4000-8000-0000000000c0' $$,
  '23514',
  null,
  'retro chat history is bounded'
);

-- --------------------------------------------------------- partition routing
select public.calculate_and_award_xp(
  'c0000000-0000-4000-8000-0000000000c0', 'bonus', null, 10, '{}'::uuid[]);

select is(
  (select c.relname::text
     from public.xp_ledger l
     join pg_class c on c.oid = l.tableoid
    where l.user_id = 'c0000000-0000-4000-8000-0000000000c0'
    limit 1),
  'xp_ledger_' || to_char(now(), 'YYYY_MM'),
  'a ledger row lands in the partition for its month'
);

-- The default partition exists so an insert outside the provisioned window
-- never fails outright.
select is(
  (select count(*)::integer
     from pg_class c
     join pg_inherits i on i.inhrelid = c.oid
    where i.inhparent = 'public.xp_ledger'::regclass
      and c.relname = 'xp_ledger_default'),
  1,
  'a default partition catches rows outside the provisioned range'
);

select * from finish();
rollback;
