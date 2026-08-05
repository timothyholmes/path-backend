-- Routines, their virtue tags, and completions.

create table if not exists public.routines (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  title         varchar(200) not null,
  description   text,
  frequency     public.routine_frequency not null,
  scheduled_day smallint,
  -- Nullable in the column definition only so the default-XP trigger can fill
  -- it by frequency; the CHECK runs after BEFORE triggers, so it is effectively
  -- NOT NULL from the caller's point of view.
  base_xp       integer,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (id, user_id),
  constraint routines_base_xp_present check (base_xp is not null),
  constraint routines_scheduled_day_valid check (
    (frequency = 'daily'   and scheduled_day is null) or
    (frequency = 'weekly'  and scheduled_day between 0 and 6) or
    (frequency = 'monthly' and scheduled_day between 1 and 31)
  )
);

comment on column public.routines.scheduled_day is
  'Day-of-week (0-6) for weekly, day-of-month (1-31) for monthly, null for daily.';

create index if not exists routines_user_active_idx
  on public.routines (user_id, is_active);

-- Base XP values from technical design §4.
create or replace function public.default_routine_xp(p_frequency public.routine_frequency)
returns integer
language sql
immutable
parallel safe
as $$
  select case p_frequency
    when 'daily'   then 10
    when 'weekly'  then 25
    when 'monthly' then 50
  end;
$$;

-- api-spec.yml documents base_xp as "defaults to the standard value for the
-- frequency", which a column default cannot express since it varies by row.
create or replace function private.apply_routine_default_xp()
returns trigger
language plpgsql
as $$
begin
  if new.base_xp is null then
    new.base_xp := public.default_routine_xp(new.frequency);
  end if;
  return new;
end;
$$;

drop trigger if exists routines_default_xp on public.routines;
create trigger routines_default_xp
  before insert on public.routines
  for each row execute function private.apply_routine_default_xp();

create table if not exists public.routine_virtues (
  routine_id uuid not null,
  virtue_id  uuid not null,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  primary key (routine_id, virtue_id),
  foreign key (routine_id, user_id) references public.routines (id, user_id) on delete cascade,
  foreign key (virtue_id,  user_id) references public.virtues  (id, user_id) on delete cascade
);

create index if not exists routine_virtues_virtue_idx
  on public.routine_virtues (virtue_id);

create table if not exists public.routine_completions (
  id                        uuid primary key default gen_random_uuid(),
  routine_id                uuid not null,
  user_id                   uuid not null references public.profiles (id) on delete cascade,
  completed_at              timestamptz not null default now(),
  -- The user-local calendar date of completion. Derived, never client-supplied.
  completed_on              date not null,
  xp_earned                 integer not null default 0,
  streak_multiplier_at_time numeric(3, 2) not null default 1.00,
  foreign key (routine_id, user_id) references public.routines (id, user_id) on delete cascade,
  -- One-tap completion is trivially double-fired by a mobile client on a flaky
  -- connection. This turns the retry into a no-op instead of double XP.
  unique (routine_id, completed_on)
);

create index if not exists routine_completions_user_date_idx
  on public.routine_completions (user_id, completed_at desc);

create index if not exists routine_completions_user_on_idx
  on public.routine_completions (user_id, completed_on desc);

create or replace function private.apply_completion_local_date()
returns trigger
language plpgsql
as $$
declare
  v_timezone text;
begin
  select p.timezone into v_timezone from public.profiles p where p.id = new.user_id;

  if v_timezone is null then
    raise exception 'no profile for user %', new.user_id using errcode = '23503';
  end if;

  new.completed_on := (new.completed_at at time zone v_timezone)::date;
  return new;
end;
$$;

comment on function private.apply_completion_local_date() is
  'Derives routine_completions.completed_on from the completing user''s timezone.';

drop trigger if exists routine_completions_local_date on public.routine_completions;
create trigger routine_completions_local_date
  before insert or update of completed_at on public.routine_completions
  for each row execute function private.apply_completion_local_date();
