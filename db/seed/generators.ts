import { Client } from 'pg';
import { createAuthUser } from './authUsers';
import { seedId, toDateString } from './rng';
import { SeededUser } from './types';

export interface UserSpec {
  key: string;
  email: string;
  displayName?: string;
  timezone?: string;
  tier?: 'free' | 'premium';
  subscriptionExpiresAt?: Date | null;
}

export interface RoutineSpec {
  key: string;
  userId: string;
  title: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  scheduledDay?: number | null;
  baseXp?: number;
  isActive?: boolean;
  virtueIds: string[];
  createdAt?: Date;
}

export interface GoalSpec {
  key: string;
  userId: string;
  title: string;
  status?: 'backlog' | 'active' | 'completed' | 'archived';
  isQuest?: boolean;
  baseXp?: number;
  dueDate?: Date | null;
  parentGoalId?: string | null;
  displayOrder?: number;
  completedAt?: Date | null;
  virtueIds?: string[];
  createdAt?: Date;
}

export interface SessionSpec {
  key: string;
  userId: string;
  title: string;
  targetDurationMinutes: number;
  virtueIds: string[];
  recurrenceRule?: Record<string, unknown> | null;
  createdAt?: Date;
}

export interface SessionInstanceSpec {
  key: string;
  sessionId: string;
  userId: string;
  scheduledAt: Date;
  status: 'scheduled' | 'in_progress' | 'completed' | 'skipped';
  startedAt?: Date | null;
  endedAt?: Date | null;
  actualDurationSeconds?: number | null;
  xpEarned?: number | null;
  skipPenaltyXp?: number | null;
  focusModeActivated?: boolean;
}

export interface LedgerSpec {
  userId: string;
  virtueIds: string[];
  sourceType: 'routine' | 'goal' | 'session' | 'retrospective' | 'bonus' | 'penalty';
  sourceId: string | null;
  baseXp: number;
  multiplier: number;
  createdAt: Date;
  description?: string;
}

/**
 * Writes seed data.
 *
 * The XP ledger is treated as the source of truth exactly as the running system
 * treats it: scenarios append ledger rows for historical activity, and
 * `finalize()` derives virtue XP, levels, global XP, the daily rollup, and the
 * streak from those rows. Nothing recomputes XP in TypeScript, so seeded data
 * cannot drift from what the database's own rules would have produced.
 *
 * Historical rows are inserted directly rather than through
 * calculate_and_award_xp(), which always stamps now() and so cannot backdate.
 */
export class Seeder {
  constructor(private readonly client: Client) {}

  /** Partitions must exist before backdated ledger rows are inserted. */
  async ensureLedgerPartitions(monthsBack: number, monthsAhead = 3): Promise<void> {
    await this.client.query('select private.ensure_xp_ledger_partitions($1, $2)', [
      monthsAhead,
      monthsBack,
    ]);
  }

  async addUser(spec: UserSpec): Promise<SeededUser> {
    const id = seedId(`user:${spec.key}`);

    // Seed ids are derived, so re-running a scenario would target the same user
    // again. Most inserts are ON CONFLICT DO NOTHING, but ledger rows are
    // append-only by design and would silently double the user's XP history.
    // Refusing is better than producing data that looks plausible and is wrong.
    const existing = await this.client.query('select 1 from public.profiles where id = $1', [id]);

    if (existing.rowCount) {
      throw new Error(
        `Seed user "${spec.key}" (${spec.email}) already exists. Reset the database before re-seeding this scenario.`,
      );
    }

    await createAuthUser(this.client, {
      id,
      email: spec.email,
      displayName: spec.displayName,
      timezone: spec.timezone,
    });

    const tier = spec.tier ?? 'free';

    await this.client.query(
      `update public.profiles
          set subscription_tier = $2,
              subscription_expires_at = $3
        where id = $1`,
      [id, tier, spec.subscriptionExpiresAt ?? null],
    );

    return { id, email: spec.email, tier };
  }

  /**
   * Backdates a subscription's expiry. Scenarios that need a lapsed premium
   * user have to create the oversized dataset while the subscription is still
   * live -- the plan-limit triggers treat an expired premium as free.
   */
  async expireSubscription(userId: string, expiredAt: Date): Promise<void> {
    await this.client.query(
      'update public.profiles set subscription_expires_at = $2 where id = $1',
      [userId, expiredAt],
    );
  }

  /** Virtues beyond the four the signup trigger creates. */
  async addVirtue(spec: {
    key: string;
    userId: string;
    name: string;
    icon?: string;
    color?: string;
    displayOrder: number;
  }): Promise<string> {
    const id = seedId(`virtue:${spec.key}`);

    await this.client.query(
      `insert into public.virtues (id, user_id, name, icon, color, display_order)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do nothing`,
      [id, spec.userId, spec.name, spec.icon ?? null, spec.color ?? null, spec.displayOrder],
    );

    return id;
  }

  async virtueIds(userId: string): Promise<string[]> {
    const { rows } = await this.client.query<{ id: string }>(
      'select id from public.virtues where user_id = $1 order by display_order, id',
      [userId],
    );
    return rows.map((row) => row.id);
  }

  async addRoutine(spec: RoutineSpec): Promise<string> {
    const id = seedId(`routine:${spec.key}`);

    await this.client.query(
      `insert into public.routines (id, user_id, title, frequency, scheduled_day, base_xp, is_active, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()))
       on conflict (id) do nothing`,
      [
        id,
        spec.userId,
        spec.title,
        spec.frequency,
        spec.scheduledDay ?? null,
        spec.baseXp ?? null,
        spec.isActive ?? true,
        spec.createdAt ?? null,
      ],
    );

    await this.tagVirtues('routine_virtues', 'routine_id', id, spec.userId, spec.virtueIds);
    return id;
  }

  async completeRoutine(spec: {
    routineId: string;
    userId: string;
    completedAt: Date;
    xpEarned: number;
    multiplier: number;
  }): Promise<void> {
    await this.client.query(
      `insert into public.routine_completions
         (routine_id, user_id, completed_at, xp_earned, streak_multiplier_at_time)
       values ($1, $2, $3, $4, $5)
       on conflict (routine_id, completed_on) do nothing`,
      [spec.routineId, spec.userId, spec.completedAt, spec.xpEarned, spec.multiplier],
    );
  }

  async addGoal(spec: GoalSpec): Promise<string> {
    const id = seedId(`goal:${spec.key}`);

    await this.client.query(
      `insert into public.goals
         (id, user_id, title, status, is_quest, base_xp, due_date, parent_goal_id, display_order, completed_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11, now()))
       on conflict (id) do nothing`,
      [
        id,
        spec.userId,
        spec.title,
        spec.status ?? 'backlog',
        spec.isQuest ?? false,
        spec.baseXp ?? 150,
        spec.dueDate ? toDateString(spec.dueDate) : null,
        spec.parentGoalId ?? null,
        spec.displayOrder ?? 0,
        spec.completedAt ?? null,
        spec.createdAt ?? null,
      ],
    );

    await this.tagVirtues('goal_virtues', 'goal_id', id, spec.userId, spec.virtueIds ?? []);
    return id;
  }

  async addBacklogItem(spec: {
    key: string;
    userId: string;
    title: string;
    notes?: string;
    source?: 'manual' | 'ai_suggestion' | 'field_log';
    virtueId?: string | null;
    promotedToGoalId?: string | null;
    createdAt?: Date;
  }): Promise<string> {
    const id = seedId(`backlog:${spec.key}`);

    await this.client.query(
      `insert into public.goal_backlog
         (id, user_id, title, notes, source, virtue_id, promoted_to_goal_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()))
       on conflict (id) do nothing`,
      [
        id,
        spec.userId,
        spec.title,
        spec.notes ?? null,
        spec.source ?? 'manual',
        spec.virtueId ?? null,
        spec.promotedToGoalId ?? null,
        spec.createdAt ?? null,
      ],
    );

    return id;
  }

  async addSession(spec: SessionSpec): Promise<string> {
    const id = seedId(`session:${spec.key}`);

    await this.client.query(
      `insert into public.sessions
         (id, user_id, title, target_duration_minutes, recurrence_rule, created_at)
       values ($1, $2, $3, $4, $5, coalesce($6, now()))
       on conflict (id) do nothing`,
      [
        id,
        spec.userId,
        spec.title,
        spec.targetDurationMinutes,
        spec.recurrenceRule ? JSON.stringify(spec.recurrenceRule) : null,
        spec.createdAt ?? null,
      ],
    );

    await this.tagVirtues('session_virtues', 'session_id', id, spec.userId, spec.virtueIds);
    return id;
  }

  async addSessionInstance(spec: SessionInstanceSpec): Promise<string> {
    const id = seedId(`session-instance:${spec.key}`);

    await this.client.query(
      `insert into public.session_instances
         (id, session_id, user_id, scheduled_at, started_at, ended_at,
          actual_duration_seconds, status, xp_earned, skip_penalty_xp, focus_mode_activated)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (id) do nothing`,
      [
        id,
        spec.sessionId,
        spec.userId,
        spec.scheduledAt,
        spec.startedAt ?? null,
        spec.endedAt ?? null,
        spec.actualDurationSeconds ?? null,
        spec.status,
        spec.xpEarned ?? null,
        spec.skipPenaltyXp ?? null,
        spec.focusModeActivated ?? false,
      ],
    );

    return id;
  }

  async addFieldLogTemplate(spec: {
    key: string;
    userId: string;
    name: string;
    prefix?: string;
    schema: Record<string, unknown>;
    aiPromptTemplate?: string;
    createsFollowup?: boolean;
  }): Promise<string> {
    const id = seedId(`template:${spec.key}`);

    await this.client.query(
      `insert into public.field_log_templates
         (id, user_id, name, prefix, schema, ai_prompt_template, creates_followup)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do nothing`,
      [
        id,
        spec.userId,
        spec.name,
        spec.prefix ?? null,
        JSON.stringify(spec.schema),
        spec.aiPromptTemplate ?? null,
        spec.createsFollowup ?? false,
      ],
    );

    return id;
  }

  async addFieldLog(spec: {
    key: string;
    userId: string;
    templateId?: string | null;
    content: Record<string, unknown>;
    aiAnalysis?: string | null;
    prefix?: string | null;
    followupReminderAt?: Date | null;
    virtueIds?: string[];
    createdAt: Date;
  }): Promise<string> {
    const id = seedId(`field-log:${spec.key}`);

    await this.client.query(
      `insert into public.field_logs
         (id, user_id, template_id, content, ai_analysis, prefix, followup_reminder_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do nothing`,
      [
        id,
        spec.userId,
        spec.templateId ?? null,
        JSON.stringify(spec.content),
        spec.aiAnalysis ?? null,
        spec.prefix ?? null,
        spec.followupReminderAt ?? null,
        spec.createdAt,
      ],
    );

    await this.tagVirtues(
      'field_log_virtues',
      'field_log_id',
      id,
      spec.userId,
      spec.virtueIds ?? [],
    );
    return id;
  }

  async addRetrospective(spec: {
    key: string;
    userId: string;
    periodType: 'weekly' | 'monthly';
    periodStart: Date;
    periodEnd: Date;
    status?: 'generated' | 'reviewed' | 'skipped';
    generatedReport?: Record<string, unknown> | null;
    analyticsData?: Record<string, unknown> | null;
    chatHistory?: Array<Record<string, unknown>>;
    userNotes?: string | null;
    xpEarned?: number | null;
    createdAt?: Date;
  }): Promise<string> {
    const id = seedId(`retro:${spec.key}`);

    await this.client.query(
      `insert into public.retrospectives
         (id, user_id, period_type, period_start, period_end, status,
          generated_report, analytics_data, chat_history, user_notes, xp_earned, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12, now()))
       on conflict (id) do nothing`,
      [
        id,
        spec.userId,
        spec.periodType,
        toDateString(spec.periodStart),
        toDateString(spec.periodEnd),
        spec.status ?? 'generated',
        spec.generatedReport ? JSON.stringify(spec.generatedReport) : null,
        spec.analyticsData ? JSON.stringify(spec.analyticsData) : null,
        JSON.stringify(spec.chatHistory ?? []),
        spec.userNotes ?? null,
        spec.xpEarned ?? null,
        spec.createdAt ?? null,
      ],
    );

    return id;
  }

  /**
   * Appends ledger rows for one awarding event, applying the same remainder
   * distribution calculate_and_award_xp() uses so that virtue totals match what
   * the live scoring path would have produced.
   */
  async addLedgerEntry(spec: LedgerSpec): Promise<number> {
    const count = spec.virtueIds.length;
    const finalXp = Math.floor(spec.baseXp * spec.multiplier);

    if (count === 0) {
      await this.client.query(
        `insert into public.xp_ledger
           (user_id, virtue_id, source_type, source_id, base_xp, multiplier, final_xp, description, created_at)
         values ($1, null, $2, $3, $4, $5, $6, $7, $8)`,
        [
          spec.userId,
          spec.sourceType,
          spec.sourceId,
          spec.baseXp,
          spec.multiplier,
          finalXp,
          spec.description ?? null,
          spec.createdAt,
        ],
      );
      return finalXp;
    }

    const perVirtue = Math.trunc(finalXp / count);
    const remainder = finalXp - perVirtue * count;

    for (let index = 0; index < count; index++) {
      const share = perVirtue + (index < Math.abs(remainder) ? Math.sign(remainder) : 0);

      await this.client.query(
        `insert into public.xp_ledger
           (user_id, virtue_id, source_type, source_id, base_xp, multiplier, final_xp, description, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          spec.userId,
          spec.virtueIds[index],
          spec.sourceType,
          spec.sourceId,
          spec.baseXp,
          spec.multiplier,
          share,
          spec.description ?? null,
          spec.createdAt,
        ],
      );
    }

    return finalXp;
  }

  /**
   * Rebuilds every derived value from the ledger: virtue XP and levels, global
   * XP and level, the daily_activity rollup, and finally the streak.
   *
   * Doing this in SQL rather than tracking running totals in TypeScript is what
   * keeps seeded data self-consistent -- the derivation here is the same one the
   * scoring function performs incrementally.
   */
  async finalize(userId: string): Promise<void> {
    await this.client.query(
      `update public.virtues v
          set xp    = coalesce(totals.total, 0),
              level = public.level_for_xp(coalesce(totals.total, 0))
         from (
           select l.virtue_id, sum(l.final_xp)::integer as total
             from public.xp_ledger l
            where l.user_id = $1 and l.virtue_id is not null
            group by l.virtue_id
         ) totals
        where v.id = totals.virtue_id and v.user_id = $1`,
      [userId],
    );

    await this.client.query(
      `update public.profiles p
          set global_xp    = coalesce(totals.total, 0),
              global_level = public.level_for_xp(coalesce(totals.total, 0)),
              last_active_at = totals.last_at
         from (
           select sum(l.final_xp)::integer as total, max(l.created_at) as last_at
             from public.xp_ledger l
            where l.user_id = $1
         ) totals
        where p.id = $1`,
      [userId],
    );

    // An awarding event is one (source_type, source_id, created_at) triple; a
    // multi-virtue award writes several ledger rows but is a single completion.
    await this.client.query(
      `insert into public.daily_activity (user_id, activity_date, completion_count, xp_earned)
       select
         l.user_id,
         (l.created_at at time zone p.timezone)::date,
         count(distinct (l.source_type, l.source_id, l.created_at))
           filter (where l.base_xp > 0),
         sum(l.final_xp)::integer
       from public.xp_ledger l
       join public.profiles p on p.id = l.user_id
       where l.user_id = $1
       group by l.user_id, (l.created_at at time zone p.timezone)::date
       on conflict (user_id, activity_date) do update
         set completion_count = excluded.completion_count,
             xp_earned        = excluded.xp_earned`,
      [userId],
    );

    await this.client.query('select public.recalculate_streak($1)', [userId]);
  }

  private async tagVirtues(
    table: 'routine_virtues' | 'goal_virtues' | 'session_virtues' | 'field_log_virtues',
    column: 'routine_id' | 'goal_id' | 'session_id' | 'field_log_id',
    entityId: string,
    userId: string,
    virtueIds: string[],
  ): Promise<void> {
    for (const virtueId of virtueIds) {
      await this.client.query(
        `insert into public.${table} (${column}, virtue_id, user_id)
         values ($1, $2, $3)
         on conflict do nothing`,
        [entityId, virtueId, userId],
      );
    }
  }
}
