-- Per-user, per-local-day activity rollup.
--
-- Not in the design doc's data model, but three separate requirements need
-- exactly this shape: the streak engine's "did the user complete at least one
-- activity on day D", AnalyticsOverview.xp_over_time, and VirtueHistory.points.
-- Deriving each from the partitioned ledger would mean a scan per query.
--
-- Maintained transactionally by calculate_and_award_xp().

create table if not exists public.daily_activity (
  user_id          uuid not null references public.profiles (id) on delete cascade,
  -- The user's local calendar date, not a UTC date.
  activity_date    date not null,
  completion_count integer not null default 0,
  xp_earned        integer not null default 0,
  primary key (user_id, activity_date)
);

comment on column public.daily_activity.completion_count is
  'Positive-XP awards only. Skip penalties reduce xp_earned without counting as activity, so they do not sustain a streak.';

create index if not exists daily_activity_user_date_idx
  on public.daily_activity (user_id, activity_date desc);

-- Streak lookups only care about days that actually had activity.
create index if not exists daily_activity_active_days_idx
  on public.daily_activity (user_id, activity_date desc)
  where completion_count > 0;
