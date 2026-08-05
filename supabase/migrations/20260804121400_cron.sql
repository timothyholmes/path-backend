-- Scheduled jobs.
--
-- pg_cron ships with the Supabase Postgres image but not with stock Postgres,
-- so everything here is guarded on availability. On a bare Postgres used for CI
-- the jobs are simply not scheduled; the functions they call are still present
-- and directly testable.

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable; skipping scheduled jobs';
    return;
  end if;

  create extension if not exists pg_cron;

  -- Streaks: hourly rather than a single daily UTC run, because local midnight
  -- lands at a different UTC hour for every user. recalculate_due_streaks()
  -- filters to users whose local date has actually advanced, so the job is
  -- cheap and idempotent.
  perform cron.unschedule('path-recalculate-streaks')
    where exists (select 1 from cron.job where jobname = 'path-recalculate-streaks');

  perform cron.schedule(
    'path-recalculate-streaks',
    '5 * * * *',
    $job$select private.recalculate_due_streaks()$job$
  );

  -- Keep the xp_ledger partition window ahead of the calendar. Rows that land
  -- in the default partition block a later ATTACH for that month.
  perform cron.unschedule('path-ensure-xp-partitions')
    where exists (select 1 from cron.job where jobname = 'path-ensure-xp-partitions');

  perform cron.schedule(
    'path-ensure-xp-partitions',
    '0 3 1 * *',
    $job$select private.ensure_xp_ledger_partitions(3, 0)$job$
  );
end
$$;

-- Retrospective generation is deliberately not scheduled here. Detecting a due
-- period is a database concern and lives in private.due_retrospective_periods();
-- generating the report is an AI call that belongs in an Edge Function. Wiring
-- the two together (pg_net, or a scheduled function invocation) comes with the
-- retrospectives pipeline in Phase 3.
