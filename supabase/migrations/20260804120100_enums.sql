-- Enum types.
--
-- Values are copied verbatim from the enum schemas in api-spec.yml so that
-- `supabase gen types typescript` emits TypeScript unions identical to the
-- OpenAPI contract. Changing a value here without changing api-spec.yml (or
-- vice versa) will surface as a type error in the Edge Functions.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'subscription_tier') then
    create type public.subscription_tier as enum ('free', 'premium');
  end if;

  if not exists (select 1 from pg_type where typname = 'routine_frequency') then
    create type public.routine_frequency as enum ('daily', 'weekly', 'monthly');
  end if;

  if not exists (select 1 from pg_type where typname = 'goal_status') then
    create type public.goal_status as enum ('backlog', 'active', 'completed', 'archived');
  end if;

  if not exists (select 1 from pg_type where typname = 'session_instance_status') then
    create type public.session_instance_status as enum ('scheduled', 'in_progress', 'completed', 'skipped');
  end if;

  if not exists (select 1 from pg_type where typname = 'xp_source_type') then
    create type public.xp_source_type as enum ('routine', 'goal', 'session', 'retrospective', 'bonus', 'penalty');
  end if;

  if not exists (select 1 from pg_type where typname = 'backlog_source') then
    create type public.backlog_source as enum ('manual', 'ai_suggestion', 'field_log');
  end if;

  if not exists (select 1 from pg_type where typname = 'retro_period_type') then
    create type public.retro_period_type as enum ('weekly', 'monthly');
  end if;

  if not exists (select 1 from pg_type where typname = 'retro_status') then
    create type public.retro_status as enum ('generated', 'reviewed', 'skipped');
  end if;

  if not exists (select 1 from pg_type where typname = 'prompt_type') then
    create type public.prompt_type as enum ('text', 'textarea', 'select', 'scale');
  end if;
end
$$;
