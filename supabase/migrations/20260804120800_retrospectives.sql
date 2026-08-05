-- Weekly and monthly retrospectives (premium).

create table if not exists public.retrospectives (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  period_type      public.retro_period_type not null,
  period_start     date not null,
  period_end       date not null,
  -- AI report with structured sections; shape owned by the prompt template.
  generated_report jsonb,
  -- Pre-computed chart data so the review UI does no aggregation.
  analytics_data   jsonb,
  chat_history     jsonb not null default '[]'::jsonb,
  user_notes       text,
  status           public.retro_status not null default 'generated',
  xp_earned        integer,
  created_at       timestamptz not null default now(),
  unique (id, user_id),
  -- One retrospective per user per period.
  unique (user_id, period_type, period_start),
  constraint retrospectives_period_ordered check (period_end >= period_start),
  constraint retrospectives_chat_is_array check (jsonb_typeof(chat_history) = 'array'),
  -- Technical design §5 caps retro chat at 20 messages to control AI cost. The
  -- product rule is enforced in the Edge Function; this is a backstop against
  -- unbounded JSONB growth, sized for 20 user/assistant exchanges.
  constraint retrospectives_chat_bounded check (jsonb_array_length(chat_history) <= 40)
);

create index if not exists retrospectives_user_period_idx
  on public.retrospectives (user_id, period_start desc);

create index if not exists retrospectives_pending_review_idx
  on public.retrospectives (user_id) where status = 'generated';

-- Periods that are due but have no retrospective row yet. The pg_cron job and
-- the generation Edge Function both read this rather than reimplementing the
-- date maths. Weekly periods close on Sunday; monthly on the 1st.
create or replace function private.due_retrospective_periods()
returns table (
  user_id     uuid,
  period_type public.retro_period_type,
  period_start date,
  period_end   date
)
language sql
stable
as $$
  with local_today as (
    select p.id as user_id, (now() at time zone p.timezone)::date as today
    from public.profiles p
    where p.subscription_tier = 'premium'
  ),
  candidates as (
    -- The week that ended yesterday, once today is a Monday.
    select
      lt.user_id,
      'weekly'::public.retro_period_type as period_type,
      lt.today - 7 as period_start,
      lt.today - 1 as period_end
    from local_today lt
    where extract(isodow from lt.today) = 1

    union all

    -- The month that ended yesterday, once today is the 1st.
    select
      lt.user_id,
      'monthly'::public.retro_period_type,
      (date_trunc('month', lt.today::timestamp) - interval '1 month')::date,
      (date_trunc('month', lt.today::timestamp) - interval '1 day')::date
    from local_today lt
    where extract(day from lt.today) = 1
  )
  select c.user_id, c.period_type, c.period_start, c.period_end
  from candidates c
  where not exists (
    select 1 from public.retrospectives r
    where r.user_id = c.user_id
      and r.period_type = c.period_type
      and r.period_start = c.period_start
  );
$$;

comment on function private.due_retrospective_periods() is
  'Premium users with a closed retro period and no row yet. Read by the retro generation pipeline.';
