-- Row Level Security isolation.
--
-- The design doc lets the mobile client talk to PostgREST directly, so these
-- policies are the actual data boundary between users, not a backstop. Each
-- assertion below is written from the attacker's side: what a signed-in user
-- can see or change that belongs to somebody else.
begin;
create extension if not exists pgtap with schema extensions;

select plan(18);

-- Two users, created through the real signup path so profiles and starter
-- virtues come from the trigger.
insert into auth.users (id, email, raw_user_meta_data)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'alice@test', '{"timezone":"UTC"}'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'bob@test',   '{"timezone":"UTC"}');

insert into public.routines (id, user_id, title, frequency)
values
  ('a0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'Alice routine', 'daily'),
  ('b0000000-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000002', 'Bob routine',   'daily');

insert into public.goals (id, user_id, title, status)
values
  ('a1000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'Alice goal', 'active'),
  ('b1000000-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000002', 'Bob goal',   'active');

insert into public.field_logs (user_id, content)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', '{"text":"alice private thoughts"}'),
  ('bbbbbbbb-0000-4000-8000-000000000002', '{"text":"bob private thoughts"}');

select public.calculate_and_award_xp(
  'aaaaaaaa-0000-4000-8000-000000000001', 'routine',
  'a0000000-0000-4000-8000-00000000000a', 10,
  array(select id from public.virtues where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' limit 1)
);

-- ---------------------------------------------------------------- as Alice
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001"}';

select is(
  (select count(*)::integer from public.profiles),
  1,
  'alice sees exactly one profile: her own'
);

select is(
  (select count(*)::integer from public.virtues),
  4,
  'alice sees only her four starter virtues'
);

select is(
  (select count(*)::integer from public.routines),
  1,
  'alice sees only her own routine'
);

select is(
  (select count(*)::integer from public.goals),
  1,
  'alice sees only her own goal'
);

select is(
  (select count(*)::integer from public.field_logs where content->>'text' like 'bob%'),
  0,
  'alice cannot read bob''s field logs'
);

select is(
  (select count(*)::integer from public.xp_ledger),
  1,
  'alice sees only her own ledger rows'
);

select is(
  (select count(*)::integer from public.daily_activity),
  1,
  'alice sees only her own activity rollup'
);

-- Writing to another user's rows must affect nothing, not error -- RLS filters
-- them out of the UPDATE's scope entirely.
update public.routines set title = 'HIJACKED' where user_id = 'bbbbbbbb-0000-4000-8000-000000000002';
select is(
  (select count(*)::integer from public.routines where title = 'HIJACKED'),
  0,
  'alice cannot update bob''s routines'
);

delete from public.goals where user_id = 'bbbbbbbb-0000-4000-8000-000000000002';

-- Inserting a row owned by somebody else must be rejected by the WITH CHECK.
select throws_ok(
  $$ insert into public.routines (user_id, title, frequency)
     values ('bbbbbbbb-0000-4000-8000-000000000002', 'planted', 'daily') $$,
  '42501',
  null,
  'alice cannot insert a routine owned by bob'
);

-- Nor reassign one of her own rows to another user.
select throws_ok(
  $$ update public.routines
        set user_id = 'bbbbbbbb-0000-4000-8000-000000000002'
      where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '42501',
  null,
  'alice cannot hand a routine to bob'
);

-- The ledger is append-only to clients.
select throws_ok(
  $$ insert into public.xp_ledger (user_id, source_type, base_xp, final_xp)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'bonus', 1000000, 1000000) $$,
  '42501',
  null,
  'alice cannot write her own ledger rows'
);

-- Column grants, not policies, are what stop a self-granted upgrade.
select throws_ok(
  $$ update public.profiles set subscription_tier = 'premium'
      where id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '42501',
  null,
  'alice cannot grant herself premium'
);

select throws_ok(
  $$ update public.profiles set global_xp = 999999
      where id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '42501',
  null,
  'alice cannot set her own XP'
);

select lives_ok(
  $$ update public.profiles set display_name = 'Alice'
      where id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  'alice can update her own display name'
);

-- SECURITY DEFINER bypasses RLS, so the function polices its caller itself.
select throws_ok(
  $$ select public.calculate_and_award_xp(
       'bbbbbbbb-0000-4000-8000-000000000002', 'bonus', null, 500, '{}'::uuid[]) $$,
  '42501',
  null,
  'alice cannot award XP to bob'
);

reset role;

-- ------------------------------------------------------------------ as Bob
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002"}';

select is(
  (select count(*)::integer from public.goals),
  1,
  'bob''s goal survived alice''s delete attempt'
);

select is(
  (select count(*)::integer from public.xp_ledger),
  0,
  'bob sees none of alice''s ledger rows'
);

reset role;

-- ----------------------------------------------------------------- as anon
set local role anon;

select throws_ok(
  $$ select count(*) from public.virtues $$,
  '42501',
  null,
  'anonymous requests are denied at the grant level'
);

reset role;

select * from finish();
rollback;
