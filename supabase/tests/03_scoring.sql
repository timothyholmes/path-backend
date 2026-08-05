-- The scoring engine, including the three defects in the design doc's version.
begin;
create extension if not exists pgtap with schema extensions;

select plan(20);

insert into auth.users (id, email, raw_user_meta_data)
values ('cccccccc-0000-4000-8000-000000000003', 'scorer@test', '{"timezone":"UTC"}');

-- Deterministic virtue ordering so remainder distribution is assertable.
update public.virtues set display_order = 0 where user_id = 'cccccccc-0000-4000-8000-000000000003' and name = 'Body';
update public.virtues set display_order = 1 where user_id = 'cccccccc-0000-4000-8000-000000000003' and name = 'Mind';
update public.virtues set display_order = 2 where user_id = 'cccccccc-0000-4000-8000-000000000003' and name = 'Craft';
update public.virtues set display_order = 3 where user_id = 'cccccccc-0000-4000-8000-000000000003' and name = 'Spirit';

-- --------------------------------------------------- single virtue, no streak
select is(
  (public.calculate_and_award_xp(
    'cccccccc-0000-4000-8000-000000000003', 'routine', null, 10,
    array(select id from public.virtues
           where user_id = 'cccccccc-0000-4000-8000-000000000003' and name = 'Body')
  ) ->> 'xp_earned')::integer,
  10,
  'one virtue at multiplier 1.0 awards the base XP'
);

select is(
  (select global_xp from public.profiles where id = 'cccccccc-0000-4000-8000-000000000003'),
  10,
  'global XP reflects the award'
);

-- ------------------------------------------------------- multi-virtue bonus
-- 1.0 + 0.10 * (3 - 1) = 1.2, so floor(10 * 1.2) = 12.
select is(
  (public.calculate_and_award_xp(
    'cccccccc-0000-4000-8000-000000000003', 'routine', null, 10,
    array(select id from public.virtues
           where user_id = 'cccccccc-0000-4000-8000-000000000003'
             and name in ('Body', 'Mind', 'Craft'))
  ) ->> 'xp_earned')::integer,
  12,
  'three virtues earn a 1.2x bonus'
);

-- 12 across 3 virtues divides evenly.
select is(
  (select count(*)::integer from public.xp_ledger
    where user_id = 'cccccccc-0000-4000-8000-000000000003' and final_xp = 4),
  3,
  'evenly divisible XP splits equally'
);

-- ------------------------------------------------ remainder distribution
-- Four virtues: bonus 1.3, floor(10 * 1.3) = 13, which does not divide by 4.
-- The design doc's floor(final/count) would award 3+3+3+3 = 12 and lose 1.
select is(
  (public.calculate_and_award_xp(
    'cccccccc-0000-4000-8000-000000000003', 'routine', null, 10,
    array(select id from public.virtues
           where user_id = 'cccccccc-0000-4000-8000-000000000003')
  ) ->> 'xp_earned')::integer,
  13,
  'four virtues earn a 1.3x bonus'
);

select results_eq(
  $$ select l.final_xp
       from public.xp_ledger l
       join public.virtues v on v.id = l.virtue_id
      where l.multiplier = 1.300
      order by v.display_order $$,
  $$ values (4), (3), (3), (3) $$,
  'the remainder goes to the lowest display_order, not the void'
);

-- The invariant the remainder distribution exists to protect.
select is(
  (select global_xp from public.profiles where id = 'cccccccc-0000-4000-8000-000000000003'),
  (select sum(xp)::integer from public.virtues where user_id = 'cccccccc-0000-4000-8000-000000000003'),
  'global XP equals the sum of virtue XP'
);

-- ------------------------------------------------------- zero-virtue award
-- The doc's array_length() returns NULL here, which made every derived value
-- NULL. Retrospective XP is global-only, so this path is reachable in normal use.
select is(
  (public.calculate_and_award_xp(
    'cccccccc-0000-4000-8000-000000000003', 'retrospective', null, 60, '{}'::uuid[]
  ) ->> 'xp_earned')::integer,
  60,
  'a zero-virtue award returns real XP rather than NULL'
);

select is(
  (select count(*)::integer from public.xp_ledger
    where user_id = 'cccccccc-0000-4000-8000-000000000003' and virtue_id is null),
  1,
  'global-only XP writes exactly one null-virtue ledger row'
);

select is(
  (public.calculate_and_award_xp(
    'cccccccc-0000-4000-8000-000000000003', 'bonus', null, 25, null
  ) ->> 'xp_earned')::integer,
  25,
  'a null virtue array behaves like an empty one'
);

-- ------------------------------------------------------------ streak stacking
update public.profiles set streak_multiplier = 2.00
 where id = 'cccccccc-0000-4000-8000-000000000003';

-- 2.0 streak x 1.2 virtue bonus = 2.4, floor(10 * 2.4) = 24.
select is(
  (public.calculate_and_award_xp(
    'cccccccc-0000-4000-8000-000000000003', 'routine',
    'e0000000-0000-4000-8000-00000000000e', 10,
    array(select id from public.virtues
           where user_id = 'cccccccc-0000-4000-8000-000000000003'
             and name in ('Body', 'Mind', 'Craft'))
  ) ->> 'xp_earned')::integer,
  24,
  'the streak multiplier stacks multiplicatively with the virtue bonus'
);

-- Selected by source_id rather than by recency: now() is the transaction
-- timestamp, so every ledger row written in this test shares a created_at.
select is(
  (select distinct multiplier from public.xp_ledger
    where source_id = 'e0000000-0000-4000-8000-00000000000e'),
  2.400::numeric(5,3),
  'the combined multiplier is recorded on the ledger row'
);

-- ------------------------------------------------------------------ penalties
-- A skip penalty must not be amplified by a long streak.
select is(
  (public.calculate_and_award_xp(
    'cccccccc-0000-4000-8000-000000000003', 'penalty', null, -25,
    array(select id from public.virtues
           where user_id = 'cccccccc-0000-4000-8000-000000000003' and name = 'Body')
  ) ->> 'xp_earned')::integer,
  -25,
  'penalties ignore the streak multiplier'
);

select is(
  (public.calculate_and_award_xp(
    'cccccccc-0000-4000-8000-000000000003', 'penalty', null, -25, '{}'::uuid[]
  ) ->> 'streak_multiplier')::numeric,
  1.00::numeric,
  'penalties report a 1.0 multiplier'
);

-- Penalties reduce the day's earnings without counting as activity, so they
-- cannot keep a streak alive on their own.
select is(
  (select completion_count from public.daily_activity
    where user_id = 'cccccccc-0000-4000-8000-000000000003'),
  6,
  'penalties do not increment the completion count'
);

-- ---------------------------------------------------------------- validation
select throws_ok(
  $$ select public.calculate_and_award_xp(
       'cccccccc-0000-4000-8000-000000000003', 'routine', null, 10,
       array['dddddddd-0000-4000-8000-000000000004'::uuid]) $$,
  '23503',
  null,
  'a virtue belonging to another user is rejected'
);

select throws_ok(
  $$ select public.calculate_and_award_xp(
       'cccccccc-0000-4000-8000-000000000003', 'routine', null, 10,
       (select array[id, id] from public.virtues
         where user_id = 'cccccccc-0000-4000-8000-000000000003' limit 1)) $$,
  '23503',
  null,
  'duplicate virtue ids are rejected rather than inflating the bonus'
);

select throws_ok(
  $$ select public.calculate_and_award_xp(
       '99999999-0000-4000-8000-000000000009', 'bonus', null, 10, '{}'::uuid[]) $$,
  '23503',
  null,
  'awarding XP to a nonexistent profile fails loudly'
);

-- ------------------------------------------------------------- ScoringResult
-- The Edge Function returns this payload straight through, so its shape is a
-- contract with api-spec.yml.
select is(
  (select count(*)::integer
     from jsonb_object_keys(
       public.calculate_and_award_xp(
         'cccccccc-0000-4000-8000-000000000003', 'bonus', null, 5, '{}'::uuid[])
     ) as key
    where key in ('xp_earned', 'base_xp', 'streak_multiplier', 'virtue_bonus',
                  'per_virtue_xp', 'global_xp', 'global_level', 'current_streak',
                  'ledger_entry_ids')),
  9,
  'the return payload matches the ScoringResult schema'
);

select is(
  (select global_xp from public.profiles where id = 'cccccccc-0000-4000-8000-000000000003'),
  (select sum(final_xp)::integer from public.xp_ledger
    where user_id = 'cccccccc-0000-4000-8000-000000000003'),
  'global XP equals the ledger total after every kind of award'
);

select * from finish();
rollback;
