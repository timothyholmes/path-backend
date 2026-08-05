-- Field logs, premium templates, and their virtue tags.

create table if not exists public.field_log_templates (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  name               varchar(100) not null,
  prefix             varchar(50),
  -- Ordered prompt definitions; shape matches the TemplateSchema component in
  -- api-spec.yml. Validated structurally here, semantically in the Edge layer.
  schema             jsonb not null,
  ai_prompt_template text,
  creates_followup   boolean not null default false,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, name),
  constraint field_log_templates_schema_shape check (
    jsonb_typeof(schema -> 'prompts') = 'array'
  )
);

create index if not exists field_log_templates_user_active_idx
  on public.field_log_templates (user_id, is_active);

create table if not exists public.field_logs (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles (id) on delete cascade,
  -- Null for a basic free-tier text log.
  template_id          uuid,
  -- Template responses, or {"text": "..."} for a basic log.
  content              jsonb not null,
  ai_analysis          text,
  prefix               varchar(50),
  followup_reminder_at timestamptz,
  -- The design doc leaves this untyped; goals is the only task-like entity, so
  -- a follow-up materialises as a goal.
  followup_task_id     uuid,
  created_at           timestamptz not null default now(),
  unique (id, user_id),
  foreign key (template_id, user_id)
    references public.field_log_templates (id, user_id) on delete set null (template_id),
  foreign key (followup_task_id, user_id)
    references public.goals (id, user_id) on delete set null (followup_task_id),
  constraint field_logs_content_is_object check (jsonb_typeof(content) = 'object')
);

create index if not exists field_logs_user_created_idx
  on public.field_logs (user_id, created_at desc);

create index if not exists field_logs_template_idx
  on public.field_logs (template_id) where template_id is not null;

-- Today view: follow-up reminders due today.
create index if not exists field_logs_followup_idx
  on public.field_logs (user_id, followup_reminder_at)
  where followup_reminder_at is not null;

-- Present in the FieldLogCreate request body in api-spec.yml, though the
-- design doc's data model omits it.
create table if not exists public.field_log_virtues (
  field_log_id uuid not null,
  virtue_id    uuid not null,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  primary key (field_log_id, virtue_id),
  foreign key (field_log_id, user_id) references public.field_logs (id, user_id) on delete cascade,
  foreign key (virtue_id,    user_id) references public.virtues    (id, user_id) on delete cascade
);

create index if not exists field_log_virtues_virtue_idx
  on public.field_log_virtues (virtue_id);
