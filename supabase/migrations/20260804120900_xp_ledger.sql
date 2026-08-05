-- XP ledger: append-only audit trail and the source of truth for scoring.
--
-- Partitioned by month per technical design §3. Range partitioning forces the
-- partition key into the primary key, hence (id, created_at).
--
-- Partitions live in `private`, not `public`, on purpose. RLS policies on a
-- partitioned parent are enforced for queries that go through the parent, but a
-- query aimed at a partition directly is governed only by that partition's own
-- policies. Keeping partitions out of the PostgREST-exposed schema removes that
-- path entirely.

create table if not exists public.xp_ledger (
  id          uuid not null default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  -- Null for global-only XP (e.g. retrospective review) per §3.
  virtue_id   uuid,
  source_type public.xp_source_type not null,
  source_id   uuid,
  base_xp     integer not null,
  -- Combined streak x multi-virtue multiplier. Ceiling is 2.0 * 1.5 = 3.0.
  multiplier  numeric(5, 3) not null default 1.000,
  final_xp    integer not null,
  description varchar(300),
  created_at  timestamptz not null default now(),
  primary key (id, created_at),
  -- MATCH SIMPLE: a null virtue_id satisfies the constraint, which is what
  -- global-only entries need.
  foreign key (virtue_id, user_id) references public.virtues (id, user_id) on delete cascade
) partition by range (created_at);

comment on table public.xp_ledger is
  'Append-only XP transactions. Written only by calculate_and_award_xp().';

create index if not exists xp_ledger_user_created_idx
  on public.xp_ledger (user_id, created_at desc);

create index if not exists xp_ledger_user_virtue_created_idx
  on public.xp_ledger (user_id, virtue_id, created_at desc);

create index if not exists xp_ledger_source_idx
  on public.xp_ledger (source_type, source_id);

create or replace function private.create_xp_ledger_partition(p_month date)
returns text
language plpgsql
as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('xp_ledger_%s', to_char(v_start, 'YYYY_MM'));
begin
  if to_regclass(format('private.%I', v_name)) is not null then
    return v_name;
  end if;

  -- Bounds are written with an explicit UTC offset. A bare date literal would
  -- be resolved against the session's TimeZone, so the same migration could
  -- produce different partition boundaries on different connections.
  execute format(
    'create table private.%I partition of public.xp_ledger for values from (%L) to (%L)',
    v_name,
    to_char(v_start, 'YYYY-MM-DD') || ' 00:00:00+00',
    to_char(v_end,   'YYYY-MM-DD') || ' 00:00:00+00'
  );

  execute format('revoke all on private.%I from public', v_name);

  return v_name;
end;
$$;

create or replace function private.ensure_xp_ledger_partitions(
  p_months_ahead integer default 3,
  p_months_back  integer default 6
)
returns integer
language plpgsql
as $$
declare
  v_offset integer;
  v_count  integer := 0;
begin
  for v_offset in -p_months_back .. p_months_ahead loop
    perform private.create_xp_ledger_partition(
      (date_trunc('month', now()) + make_interval(months => v_offset))::date
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function private.ensure_xp_ledger_partitions(integer, integer) is
  'Creates monthly xp_ledger partitions around the current month. Run monthly by pg_cron.';

-- Catches anything outside the provisioned range so an insert never fails.
-- Tradeoff: rows that land here block a later ATTACH for the same month, so the
-- cron job must stay ahead of the calendar. Seeding historical data must call
-- ensure_xp_ledger_partitions() with enough back-months first.
create table if not exists private.xp_ledger_default partition of public.xp_ledger default;

revoke all on private.xp_ledger_default from public;

select private.ensure_xp_ledger_partitions(3, 6);
