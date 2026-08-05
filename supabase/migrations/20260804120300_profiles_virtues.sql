-- Profiles and Virtues.
--
-- `profiles` extends Supabase Auth's auth.users via the profiles-table pattern
-- (technical design §3): the primary key *is* the auth uid, so there is no
-- separate user table and auth.uid() joins directly against it.
--
-- All timestamps are timestamptz, not the naive TIMESTAMP the design doc lists.
-- profiles.timezone drives streak resets at local midnight, which is not
-- expressible with naive timestamps.

create table if not exists public.profiles (
  id                      uuid primary key references auth.users (id) on delete cascade,
  email                   varchar(255),
  display_name            varchar(100),
  timezone                varchar(50)   not null default 'UTC',
  subscription_tier       public.subscription_tier not null default 'free',
  subscription_expires_at timestamptz,
  -- XP is not constrained to be non-negative: session skip penalties write
  -- negative ledger rows, and clamping here would break the invariant that
  -- global_xp equals the sum of the user's virtue XP.
  global_xp               integer       not null default 0,
  global_level            integer       not null default 1 check (global_level >= 1),
  current_streak          integer       not null default 0 check (current_streak >= 0),
  longest_streak          integer       not null default 0 check (longest_streak >= 0),
  streak_multiplier       numeric(3, 2) not null default 1.00
                            check (streak_multiplier between 1.00 and 2.00),
  -- Local date the streak was last recalculated. Lets the hourly cron job be
  -- idempotent and correct across timezones even if a run is missed.
  streak_calculated_on    date,
  created_at              timestamptz   not null default now(),
  last_active_at          timestamptz
);

comment on column public.profiles.timezone is
  'IANA timezone. Drives routine completion dates, streak resets, and retro periods.';

create index if not exists profiles_subscription_tier_idx
  on public.profiles (subscription_tier);

-- An invalid timezone silently breaks streaks and completion dates, so reject it
-- at write time. A CHECK constraint cannot be used because timezone resolution
-- is STABLE, not IMMUTABLE.
create or replace function private.validate_timezone()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'invalid IANA timezone: %', new.timezone
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_validate_timezone on public.profiles;
create trigger profiles_validate_timezone
  before insert or update of timezone on public.profiles
  for each row execute function private.validate_timezone();

create table if not exists public.virtues (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  name          varchar(50) not null,
  icon          varchar(50),
  color         varchar(7) check (color ~ '^#[0-9a-fA-F]{6}$'),
  xp            integer not null default 0,
  level         integer not null default 1 check (level >= 1),
  display_order integer not null default 0,
  created_at    timestamptz not null default now(),
  -- Every child table carries a denormalised user_id and references this pair,
  -- which makes a row belonging to one user but tagged with another user's
  -- virtue impossible to represent.
  unique (id, user_id),
  unique (user_id, name)
);

create index if not exists virtues_user_order_idx
  on public.virtues (user_id, display_order);

-- Signup hook: materialise the profile and a starter set of virtues.
-- Exactly four defaults, which is also the free-tier cap.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, display_name, timezone)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      nullif(split_part(coalesce(new.email, ''), '@', 1), '')
    ),
    coalesce(new.raw_user_meta_data ->> 'timezone', 'UTC')
  )
  on conflict (id) do nothing;

  insert into public.virtues (user_id, name, icon, color, display_order)
  select new.id, d.name, d.icon, d.color, d.ord
  from (values
    ('Body',   'figure.run',      '#E5533D', 0),
    ('Mind',   'book.closed',     '#3D7EE5', 1),
    ('Craft',  'hammer',          '#E5A93D', 2),
    ('Spirit', 'sparkles',        '#8B3DE5', 3)
  ) as d(name, icon, color, ord)
  on conflict (user_id, name) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Creates the profile row and four starter virtues when an auth.users row is inserted.';

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
