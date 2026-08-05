-- Focused work sessions and their timed instances.

create table if not exists public.sessions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.profiles (id) on delete cascade,
  title                   varchar(200) not null,
  target_duration_minutes integer not null check (target_duration_minutes > 0),
  -- iCal-style RRULE, stored as JSONB so recurrence expansion stays in the
  -- application layer where the user's timezone is already in hand.
  recurrence_rule         jsonb,
  base_xp                 integer,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  unique (id, user_id),
  constraint sessions_base_xp_present check (base_xp is not null)
);

create index if not exists sessions_user_active_idx
  on public.sessions (user_id, is_active);

-- Base XP values from technical design §4: 30 min -> 40, 60 -> 75, 90 -> 100.
-- Custom (premium) durations interpolate off the 30-minute rate.
create or replace function public.default_session_xp(p_minutes integer)
returns integer
language sql
immutable
parallel safe
as $$
  select case p_minutes
    when 30 then 40
    when 60 then 75
    when 90 then 100
    else greatest(floor(p_minutes * 40.0 / 30.0)::integer, 1)
  end;
$$;

create or replace function private.apply_session_default_xp()
returns trigger
language plpgsql
as $$
begin
  if new.base_xp is null then
    new.base_xp := public.default_session_xp(new.target_duration_minutes);
  end if;
  return new;
end;
$$;

drop trigger if exists sessions_default_xp on public.sessions;
create trigger sessions_default_xp
  before insert on public.sessions
  for each row execute function private.apply_session_default_xp();

create table if not exists public.session_virtues (
  session_id uuid not null,
  virtue_id  uuid not null,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  primary key (session_id, virtue_id),
  foreign key (session_id, user_id) references public.sessions (id, user_id) on delete cascade,
  foreign key (virtue_id,  user_id) references public.virtues  (id, user_id) on delete cascade
);

create index if not exists session_virtues_virtue_idx
  on public.session_virtues (virtue_id);

create table if not exists public.session_instances (
  id                      uuid primary key default gen_random_uuid(),
  session_id              uuid not null,
  user_id                 uuid not null references public.profiles (id) on delete cascade,
  scheduled_at            timestamptz,
  started_at              timestamptz,
  ended_at                timestamptz,
  actual_duration_seconds integer check (actual_duration_seconds >= 0),
  status                  public.session_instance_status not null default 'scheduled',
  xp_earned               integer,
  -- Negative XP for a skip: floor(base_xp * 0.25). Stored positive here and
  -- written to the ledger as a negative row.
  skip_penalty_xp         integer,
  focus_mode_activated    boolean not null default false,
  created_at              timestamptz not null default now(),
  foreign key (session_id, user_id) references public.sessions (id, user_id) on delete cascade,
  constraint session_instances_ended_after_started check (
    ended_at is null or (started_at is not null and ended_at >= started_at)
  ),
  constraint session_instances_completed_has_end check (
    status <> 'completed' or ended_at is not null
  ),
  constraint session_instances_started_has_start check (
    status not in ('in_progress', 'completed') or started_at is not null
  )
);

create index if not exists session_instances_user_scheduled_idx
  on public.session_instances (user_id, scheduled_at desc);

create index if not exists session_instances_session_idx
  on public.session_instances (session_id, scheduled_at desc);

-- A recurring session expands to at most one instance per scheduled slot.
-- Ad-hoc sessions leave scheduled_at null, and NULLs do not collide.
create unique index if not exists session_instances_slot_idx
  on public.session_instances (session_id, scheduled_at)
  where scheduled_at is not null;

-- Powers the Today view's in-flight timer lookup.
create index if not exists session_instances_active_idx
  on public.session_instances (user_id) where status = 'in_progress';
