-- Goals, subtasks, quests, and the idea backlog.

create table if not exists public.goals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  title          varchar(300) not null,
  description    text,
  is_quest       boolean not null default false,
  status         public.goal_status not null default 'backlog',
  due_date       date,
  base_xp        integer not null default 150,
  -- Subtasks self-reference. The composite FK keeps a subtask from being
  -- attached to another user's goal.
  parent_goal_id uuid,
  display_order  integer not null default 0,
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  unique (id, user_id),
  foreign key (parent_goal_id, user_id) references public.goals (id, user_id) on delete cascade,
  constraint goals_not_self_parent check (parent_goal_id is null or parent_goal_id <> id),
  constraint goals_completed_at_matches_status check (
    (status = 'completed' and completed_at is not null) or
    (status <> 'completed' and completed_at is null)
  )
);

create index if not exists goals_user_status_idx
  on public.goals (user_id, status);

create index if not exists goals_parent_idx
  on public.goals (parent_goal_id) where parent_goal_id is not null;

-- Powers the Today view's active-quest cards.
create index if not exists goals_user_quest_idx
  on public.goals (user_id) where is_quest and status = 'active';

create table if not exists public.goal_virtues (
  goal_id   uuid not null,
  virtue_id uuid not null,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  primary key (goal_id, virtue_id),
  foreign key (goal_id,   user_id) references public.goals   (id, user_id) on delete cascade,
  foreign key (virtue_id, user_id) references public.virtues (id, user_id) on delete cascade
);

create index if not exists goal_virtues_virtue_idx
  on public.goal_virtues (virtue_id);

create table if not exists public.goal_backlog (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles (id) on delete cascade,
  title               varchar(300) not null,
  notes               text,
  source              public.backlog_source not null default 'manual',
  -- Originating field log or retrospective. Deliberately not a foreign key:
  -- it points at different tables depending on `source`.
  source_id           uuid,
  virtue_id           uuid,
  promoted_to_goal_id uuid,
  created_at          timestamptz not null default now(),
  -- SET NULL is scoped to the referencing column so the NOT NULL user_id is not
  -- nulled along with it (requires PostgreSQL 15+).
  foreign key (virtue_id, user_id)
    references public.virtues (id, user_id) on delete set null (virtue_id),
  foreign key (promoted_to_goal_id, user_id)
    references public.goals (id, user_id) on delete set null (promoted_to_goal_id)
);

create index if not exists goal_backlog_user_idx
  on public.goal_backlog (user_id, created_at desc);

-- Unpromoted ideas are what the backlog view and the AI suggestion engine read.
create index if not exists goal_backlog_pending_idx
  on public.goal_backlog (user_id) where promoted_to_goal_id is null;
