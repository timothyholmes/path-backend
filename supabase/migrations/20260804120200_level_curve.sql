-- XP curve and level derivation.
--
-- Technical design §4 gives the curve as `XP required for level N = floor(100 * N^1.8)`.
-- NOTE: the illustrative table printed alongside that formula in the design doc
-- does not follow it (it shows 1,380 at level 5 where the formula gives 1,812,
-- and 271,227 at level 100 where the formula gives 398,100). The formula is
-- treated as normative here; the doc's table needs correcting.
--
-- `xp_for_level(N)` is the XP needed to clear level N. `level_thresholds`
-- materialises the running total so level lookup is an index scan rather than a
-- loop, and so the curve is inspectable from SQL.

create or replace function public.xp_for_level(p_level integer)
returns integer
language sql
immutable
parallel safe
as $$
  select case
    when p_level < 1 then 0
    else floor(100 * power(p_level::numeric, 1.8))::integer
  end;
$$;

comment on function public.xp_for_level(integer) is
  'XP required to clear level N: floor(100 * N^1.8). Technical design §4.';

create table if not exists public.level_thresholds (
  level         integer primary key check (level >= 1),
  xp_required   integer not null,
  cumulative_xp bigint  not null
);

comment on table public.level_thresholds is
  'Generated XP curve. cumulative_xp(N) is the total XP at which a user becomes level N+1.';

create index if not exists level_thresholds_cumulative_idx
  on public.level_thresholds (cumulative_xp);

-- Regenerate on every run so a change to xp_for_level() propagates.
insert into public.level_thresholds (level, xp_required, cumulative_xp)
select
  lvl,
  public.xp_for_level(lvl),
  sum(public.xp_for_level(lvl)) over (order by lvl)
from generate_series(1, 200) as lvl
on conflict (level) do update
  set xp_required   = excluded.xp_required,
      cumulative_xp = excluded.cumulative_xp;

-- A user starts at level 1 with 0 XP and becomes level N+1 once their total XP
-- reaches cumulative_xp(N). XP can go negative via penalties, so clamp at 0.
create or replace function public.level_for_xp(p_xp integer)
returns integer
language sql
stable
parallel safe
as $$
  select coalesce(
    (select max(t.level) + 1
       from public.level_thresholds t
      where t.cumulative_xp <= greatest(coalesce(p_xp, 0), 0)),
    1
  );
$$;

comment on function public.level_for_xp(integer) is
  'Inverse of the XP curve. Returns 1 for any XP below the level-2 threshold.';

alter table public.level_thresholds enable row level security;

-- Reference data: readable by everyone, writable by no one through PostgREST.
drop policy if exists "level_thresholds are readable by all" on public.level_thresholds;
create policy "level_thresholds are readable by all"
  on public.level_thresholds for select
  using (true);
