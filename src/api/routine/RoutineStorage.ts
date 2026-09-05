import { Pool, PoolClient } from 'pg';
import { Config, Dependencies } from '../../config';
import {
  Routine,
  RoutineCreateInput,
  RoutineListQuery,
  RoutineUpdateInput,
  ScoringResult,
} from '../../types';
import { NotFound } from '../../errors/notFound';
import { Conflict } from '../../errors/conflict';
import { BadRequest } from '../../errors/badRequest';
import { PaymentRequired } from '../../errors/paymentRequired';
import { ServerError } from '../../errors/serverError';
import {
  isCheckViolation,
  isForeignKeyViolation,
  isPostgresError,
  isUniqueViolation,
  parsePlanLimitError,
} from '../shared/postgresErrors';

interface RoutineRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  frequency: Routine['frequency'];
  scheduled_day: number | null;
  base_xp: number;
  is_active: boolean;
  created_at: Date;
  virtue_ids: string[];
}

function toRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    description: row.description,
    frequency: row.frequency,
    scheduled_day: row.scheduled_day,
    base_xp: row.base_xp,
    is_active: row.is_active,
    virtue_ids: row.virtue_ids,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Mirrors the `routines_scheduled_day_valid` CHECK constraint in application
 * code. Postgres treats a CHECK expression that evaluates to NULL as
 * satisfied rather than violated, so `UPDATE routines SET frequency = $1`
 * alone — leaving a NULL `scheduled_day` untouched — would silently produce a
 * `weekly`/`monthly` routine with no scheduled day instead of failing. A
 * partial update can change either column without the other, so the
 * constraint must be re-checked here against the *effective* combination.
 */
function assertValidSchedule(frequency: Routine['frequency'], scheduledDay: number | null): void {
  const valid =
    (frequency === 'daily' && scheduledDay === null) ||
    (frequency === 'weekly' && scheduledDay !== null && scheduledDay >= 0 && scheduledDay <= 6) ||
    (frequency === 'monthly' && scheduledDay !== null && scheduledDay >= 1 && scheduledDay <= 31);

  if (!valid) {
    throw new BadRequest(
      'scheduled_day is invalid for the given frequency (weekly: 0-6, monthly: 1-31, daily: omit/null).',
    );
  }
}

/**
 * Postgres-backed storage for `public.routines`, `public.routine_virtues`, and
 * `public.routine_completions`. The pool connects with a role that bypasses RLS
 * (see `src/api/shared/db.ts`), so every query here filters by `user_id`
 * explicitly instead of relying on the database to enforce ownership.
 */
class RoutineStorage {
  config: Config;
  pool: Pool;
  logger: Console;

  constructor(config: Config, dependencies: Pick<Dependencies, 'pool' | 'logger'>) {
    this.config = config;
    this.pool = dependencies.pool;
    this.logger = dependencies.logger;
  }

  async list(userId: string, query: RoutineListQuery): Promise<Routine[]> {
    const { rows } = await this.pool.query<RoutineRow>(
      `select r.id, r.user_id, r.title, r.description, r.frequency, r.scheduled_day,
              r.base_xp, r.is_active, r.created_at,
              coalesce(
                array_agg(rv.virtue_id) filter (where rv.virtue_id is not null),
                '{}'
              ) as virtue_ids
         from public.routines r
         left join public.routine_virtues rv on rv.routine_id = r.id
        where r.user_id = $1
          and ($2::boolean is null or r.is_active = $2)
          and ($3::public.routine_frequency is null or r.frequency = $3)
        group by r.id
        order by r.created_at desc`,
      [userId, query.isActive ?? null, query.frequency ?? null],
    );

    return rows.map(toRoutine);
  }

  async create(userId: string, input: RoutineCreateInput): Promise<Routine> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const { rows } = await client.query<RoutineRow>(
        `insert into public.routines (user_id, title, description, frequency, scheduled_day, base_xp)
         values ($1, $2, $3, $4, $5, $6)
         returning id, user_id, title, description, frequency, scheduled_day, base_xp, is_active, created_at`,
        [
          userId,
          input.title,
          input.description ?? null,
          input.frequency,
          input.scheduled_day ?? null,
          input.base_xp ?? null,
        ],
      );
      const routine = rows[0];

      await client.query(
        `insert into public.routine_virtues (routine_id, virtue_id, user_id)
         select $1, unnest($2::uuid[]), $3`,
        [routine.id, input.virtue_ids, userId],
      );

      await client.query('commit');

      return toRoutine({ ...routine, virtue_ids: input.virtue_ids });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw this.mapWriteError(err);
    } finally {
      client.release();
    }
  }

  async update(userId: string, routineId: string, patch: RoutineUpdateInput): Promise<Routine> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const row = await this.applyScalarUpdate(client, userId, routineId, patch);
      if (!row) {
        throw new NotFound(`Routine with ID ${routineId} not found`);
      }

      const virtueIds = await this.applyVirtueUpdate(client, userId, routineId, patch);

      await client.query('commit');
      return toRoutine({ ...row, virtue_ids: virtueIds });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw this.mapWriteError(err);
    } finally {
      client.release();
    }
  }

  async delete(userId: string, routineId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `delete from public.routines where id = $1 and user_id = $2`,
      [routineId, userId],
    );

    if (rowCount === 0) {
      throw new NotFound(`Routine with ID ${routineId} not found`);
    }
  }

  async complete(userId: string, routineId: string, completedAt?: string): Promise<ScoringResult> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const routine = await this.findForCompletion(client, userId, routineId);
      if (!routine) {
        throw new NotFound(`Routine with ID ${routineId} not found`);
      }

      const completionId = await this.insertCompletion(client, userId, routineId, completedAt);

      const { rows } = await client.query<{ result: ScoringResult }>(
        `select public.calculate_and_award_xp(
           $1::uuid, 'routine'::public.xp_source_type, $2::uuid, $3::integer, $4::uuid[], $5::varchar
         ) as result`,
        [
          userId,
          routineId,
          routine.base_xp,
          routine.virtue_ids,
          `Completed routine "${routine.title}"`,
        ],
      );
      const result = rows[0].result;

      await client.query(
        `update public.routine_completions
            set xp_earned = $1, streak_multiplier_at_time = $2
          where id = $3`,
        [result.xp_earned, result.streak_multiplier, completionId],
      );

      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw this.mapCompleteError(err);
    } finally {
      client.release();
    }
  }

  private async findForCompletion(
    client: PoolClient,
    userId: string,
    routineId: string,
  ): Promise<{ title: string; base_xp: number; virtue_ids: string[] } | null> {
    const { rows } = await client.query<{ title: string; base_xp: number }>(
      `select title, base_xp from public.routines where id = $1 and user_id = $2`,
      [routineId, userId],
    );
    if (rows.length === 0) {
      return null;
    }

    const { rows: virtueRows } = await client.query<{ virtue_id: string }>(
      `select virtue_id from public.routine_virtues where routine_id = $1`,
      [routineId],
    );

    return { ...rows[0], virtue_ids: virtueRows.map((row) => row.virtue_id) };
  }

  /**
   * Updates only the scalar columns present on `patch`, so an omitted field is
   * left untouched rather than overwritten with a default. Returns null if the
   * routine doesn't exist or isn't owned by `userId`; returns the current row
   * unchanged (no UPDATE issued) when `patch` carries no scalar fields at all.
   */
  private async applyScalarUpdate(
    client: PoolClient,
    userId: string,
    routineId: string,
    patch: RoutineUpdateInput,
  ): Promise<RoutineRow | null> {
    const { rows: currentRows } = await client.query<RoutineRow>(
      `select id, user_id, title, description, frequency, scheduled_day, base_xp, is_active, created_at
         from public.routines where id = $1 and user_id = $2
         for update`,
      [routineId, userId],
    );
    const current = currentRows[0];
    if (!current) {
      return null;
    }

    assertValidSchedule(
      patch.frequency ?? current.frequency,
      patch.scheduled_day !== undefined ? patch.scheduled_day : current.scheduled_day,
    );

    const columns: Array<[string, unknown]> = [];
    if (patch.title !== undefined) columns.push(['title', patch.title]);
    if (patch.description !== undefined) columns.push(['description', patch.description]);
    if (patch.frequency !== undefined) columns.push(['frequency', patch.frequency]);
    if (patch.scheduled_day !== undefined) columns.push(['scheduled_day', patch.scheduled_day]);
    if (patch.base_xp !== undefined) columns.push(['base_xp', patch.base_xp]);
    if (patch.is_active !== undefined) columns.push(['is_active', patch.is_active]);

    if (columns.length === 0) {
      return current;
    }

    const setClause = columns.map(([column], index) => `${column} = $${index + 1}`).join(', ');
    const values = columns.map(([, value]) => value);

    const { rows } = await client.query<RoutineRow>(
      `update public.routines set ${setClause}
        where id = $${values.length + 1} and user_id = $${values.length + 2}
        returning id, user_id, title, description, frequency, scheduled_day, base_xp, is_active, created_at`,
      [...values, routineId, userId],
    );
    return rows[0] ?? null;
  }

  /** Replaces the routine's tagged virtues when `patch.virtue_ids` is present; otherwise returns the current tags. */
  private async applyVirtueUpdate(
    client: PoolClient,
    userId: string,
    routineId: string,
    patch: RoutineUpdateInput,
  ): Promise<string[]> {
    if (patch.virtue_ids === undefined) {
      const { rows } = await client.query<{ virtue_id: string }>(
        `select virtue_id from public.routine_virtues where routine_id = $1`,
        [routineId],
      );
      return rows.map((row) => row.virtue_id);
    }

    await client.query(`delete from public.routine_virtues where routine_id = $1`, [routineId]);
    await client.query(
      `insert into public.routine_virtues (routine_id, virtue_id, user_id)
       select $1, unnest($2::uuid[]), $3`,
      [routineId, patch.virtue_ids, userId],
    );
    return patch.virtue_ids;
  }

  private async insertCompletion(
    client: PoolClient,
    userId: string,
    routineId: string,
    completedAt: string | undefined,
  ): Promise<string> {
    try {
      const { rows } = await client.query<{ id: string }>(
        `insert into public.routine_completions (routine_id, user_id, completed_at)
         values ($1, $2, coalesce($3::timestamptz, now()))
         returning id`,
        [routineId, userId, completedAt ?? null],
      );
      return rows[0].id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Conflict(`Routine ${routineId} was already completed for this period.`);
      }
      throw err;
    }
  }

  private mapWriteError(err: unknown): Error {
    if (err instanceof ServerError) {
      return err;
    }

    const planLimit = parsePlanLimitError(err);
    if (planLimit?.table === 'routines') {
      return new PaymentRequired(
        `Free plan allows at most ${planLimit.limit} active routines. Upgrade to premium for unlimited routines.`,
      );
    }

    if (isForeignKeyViolation(err)) {
      return new BadRequest('One or more virtue_ids do not exist for this user.');
    }

    if (isUniqueViolation(err)) {
      return new BadRequest('virtue_ids must not contain duplicates.');
    }

    if (isCheckViolation(err)) {
      return new BadRequest(
        'scheduled_day is invalid for the given frequency (weekly: 0-6, monthly: 1-31, daily: omit).',
      );
    }

    return err as Error;
  }

  private mapCompleteError(err: unknown): Error {
    if (err instanceof ServerError) {
      return err;
    }

    if (isPostgresError(err) && err.code === '22007') {
      return new BadRequest('completed_at is not a valid date-time.');
    }

    return err as Error;
  }
}

export default RoutineStorage;
