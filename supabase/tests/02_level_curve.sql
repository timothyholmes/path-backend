-- XP curve and level derivation.
--
-- The design doc's printed table does not match its own formula, so these
-- assertions are written against the formula, which is normative. If the
-- product decides the table was right, this file is where that decision gets
-- recorded.
begin;
create extension if not exists pgtap with schema extensions;

select plan(14);

-- floor(100 * N^1.8)
select is(public.xp_for_level(1), 100, 'level 1 costs 100 XP');
select is(public.xp_for_level(2), 348, 'level 2 costs 348 XP');
select is(public.xp_for_level(5), 1811, 'level 5 costs 1811 XP');
select is(public.xp_for_level(10), 6309, 'level 10 costs 6309 XP');
select is(public.xp_for_level(0), 0, 'levels below 1 cost nothing');

-- The lookup table must agree with the function it was generated from.
select is(
  (select count(*)::integer
     from public.level_thresholds t
    where t.xp_required <> public.xp_for_level(t.level)),
  0,
  'level_thresholds agrees with xp_for_level at every level'
);

-- cumulative_xp is a running sum, which is what level_for_xp bisects on.
select is(
  (select cumulative_xp::integer from public.level_thresholds where level = 1),
  100,
  'cumulative XP after level 1 is 100'
);

select is(
  (select cumulative_xp::integer from public.level_thresholds where level = 2),
  448,
  'cumulative XP after level 2 is 448'
);

select is(
  (select count(*)::integer
     from public.level_thresholds a
     join public.level_thresholds b on b.level = a.level - 1
    where a.cumulative_xp <> b.cumulative_xp + a.xp_required),
  0,
  'cumulative_xp is a true running total'
);

-- level_for_xp is the exact inverse, including at the boundaries where an
-- off-by-one shows up as a level that flickers.
select is(public.level_for_xp(0), 1, 'a new user is level 1');
select is(public.level_for_xp(99), 1, 'one XP short of the threshold is still level 1');
select is(public.level_for_xp(100), 2, 'hitting the threshold exactly levels up');
select is(public.level_for_xp(447), 2, 'one short of the next threshold holds at 2');

-- Penalties can drive XP negative; the curve must clamp rather than error.
select is(public.level_for_xp(-500), 1, 'negative XP clamps to level 1');

select * from finish();
rollback;
