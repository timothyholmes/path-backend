-- Free-tier plan limits.
--
-- These caps are specified in the design doc as an Edge Function concern, but
-- the client can reach PostgREST directly, so they are enforced in the database.
-- The multi-row cases below are the ones a per-row trigger would miss.
begin;
create extension if not exists pgtap with schema extensions;

select plan(13);

insert into auth.users (id, email, raw_user_meta_data)
values
  ('f0000000-0000-4000-8000-00000000000f', 'free@test',    '{"timezone":"UTC"}'),
  ('40000000-0000-4000-8000-000000000004', 'premium@test', '{"timezone":"UTC"}'),
  ('1a000000-0000-4000-8000-00000000001a', 'lapsed@test',  '{"timezone":"UTC"}');

update public.profiles set subscription_tier = 'premium'
 where id = '40000000-0000-4000-8000-000000000004';

-- ----------------------------------------------------------------- virtues
-- Signup already created four, which is the cap.
select is(
  (select count(*)::integer from public.virtues where user_id = 'f0000000-0000-4000-8000-00000000000f'),
  4,
  'signup creates exactly the free-tier virtue allowance'
);

select throws_ok(
  $$ insert into public.virtues (user_id, name) values ('f0000000-0000-4000-8000-00000000000f', 'Fifth') $$,
  'P0001',
  null,
  'a fifth virtue is rejected on the free plan'
);

-- A single multi-row INSERT is invisible to a per-row BEFORE trigger, because
-- rows inserted earlier in the same statement are not in its snapshot.
select throws_ok(
  $$ insert into public.virtues (user_id, name)
     select 'f0000000-0000-4000-8000-00000000000f', 'Bulk' || g from generate_series(1, 5) g $$,
  'P0001',
  null,
  'a multi-row insert cannot slip past the virtue cap'
);

select lives_ok(
  $$ insert into public.virtues (user_id, name)
     select '40000000-0000-4000-8000-000000000004', 'Bulk' || g from generate_series(1, 20) g $$,
  'premium has no virtue cap'
);

-- ---------------------------------------------------------------- routines
insert into public.routines (user_id, title, frequency)
select 'f0000000-0000-4000-8000-00000000000f', 'Routine ' || g, 'daily'
from generate_series(1, 10) g;

select is(
  (select count(*)::integer from public.routines where user_id = 'f0000000-0000-4000-8000-00000000000f'),
  10,
  'ten active routines is allowed'
);

select throws_ok(
  $$ insert into public.routines (user_id, title, frequency)
     values ('f0000000-0000-4000-8000-00000000000f', 'Eleventh', 'daily') $$,
  'P0001',
  null,
  'an eleventh active routine is rejected'
);

-- Only active routines count, so archiving one frees a slot.
update public.routines set is_active = false
 where user_id = 'f0000000-0000-4000-8000-00000000000f'
   and title = 'Routine 1';

select lives_ok(
  $$ insert into public.routines (user_id, title, frequency)
     values ('f0000000-0000-4000-8000-00000000000f', 'Replacement', 'daily') $$,
  'deactivating a routine frees a slot'
);

-- Reactivation is an UPDATE, and must be capped too.
select throws_ok(
  $$ update public.routines set is_active = true
      where user_id = 'f0000000-0000-4000-8000-00000000000f' and title = 'Routine 1' $$,
  'P0001',
  null,
  'reactivating a routine over the cap is rejected'
);

-- -------------------------------------------------------------------- goals
insert into public.goals (user_id, title, status)
select 'f0000000-0000-4000-8000-00000000000f', 'Goal ' || g, 'active'
from generate_series(1, 3) g;

select throws_ok(
  $$ insert into public.goals (user_id, title, status)
     values ('f0000000-0000-4000-8000-00000000000f', 'Fourth', 'active') $$,
  'P0001',
  null,
  'a fourth active goal is rejected'
);

-- Backlog and archived goals are unlimited; only active ones are capped.
select lives_ok(
  $$ insert into public.goals (user_id, title, status)
     select 'f0000000-0000-4000-8000-00000000000f', 'Idea ' || g, 'backlog'
     from generate_series(1, 25) g $$,
  'backlog goals are not capped'
);

-- Promoting a backlog item to active is the most likely way to cross the line.
select throws_ok(
  $$ update public.goals set status = 'active'
      where user_id = 'f0000000-0000-4000-8000-00000000000f' and title = 'Idea 1' $$,
  'P0001',
  null,
  'promoting a backlog goal past the cap is rejected'
);

-- --------------------------------------------------------- lapsed premium
update public.profiles
   set subscription_tier = 'premium',
       subscription_expires_at = now() + interval '30 days'
 where id = '1a000000-0000-4000-8000-00000000001a';

insert into public.routines (user_id, title, frequency)
select '1a000000-0000-4000-8000-00000000001a', 'Premium routine ' || g, 'daily'
from generate_series(1, 15) g;

update public.profiles set subscription_expires_at = now() - interval '1 day'
 where id = '1a000000-0000-4000-8000-00000000001a';

-- Rows created while premium survive the lapse.
select is(
  (select count(*)::integer from public.routines where user_id = '1a000000-0000-4000-8000-00000000001a'),
  15,
  'a lapsed subscription does not delete existing rows'
);

select throws_ok(
  $$ insert into public.routines (user_id, title, frequency)
     values ('1a000000-0000-4000-8000-00000000001a', 'After lapse', 'daily') $$,
  'P0001',
  null,
  'an expired premium subscription is capped like a free plan'
);

select * from finish();
rollback;
