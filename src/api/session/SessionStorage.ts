import { Pool, PoolClient } from 'pg';
import { Config, Dependencies } from '../../config';
import {
  ScoringResult,
  Session,
  SessionCreateInput,
  SessionInstance,
  SessionListQuery,
  SessionUpdateInput,
  TimerState,
} from '../../types';
import { NotFound } from '../../errors/notFound';
import { Conflict } from '../../errors/conflict';
import { BadRequest } from '../../errors/badRequest';
import { PaymentRequired } from '../../errors/paymentRequired';
import { ServerError } from '../../errors/serverError';
import { isForeignKeyViolation, isUniqueViolation } from '../shared/postgresErrors';

interface SessionRow {
  id: string;
  user_id: string;
  title: string;
  target_duration_minutes: number;
  recurrence_rule: Record<string, unknown> | null;
  base_xp: number;
  is_active: boolean;
  created_at: Date;
  virtue_ids: string[];
}

interface SessionInstanceRow {
  id: string;
  session_id: string;
  user_id: string;
  scheduled_at: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  actual_duration_seconds: number | null;
  status: SessionInstance['status'];
  xp_earned: number | null;
  skip_penalty_xp: number | null;
  focus_mode_activated: boolean;
}

const SESSION_COLUMNS = `id, user_id, title, target_duration_minutes, recurrence_rule,
                         base_xp, is_active, created_at`;

const INSTANCE_COLUMNS = `id, session_id, user_id, scheduled_at, started_at, ended_at,
                          actual_duration_seconds, status, xp_earned, skip_penalty_xp,
                          focus_mode_activated`;

/** The durations `public.default_session_xp` has a fixed rate for; anything else is premium (api-spec.yml). */
const STANDARD_DURATION_MINUTES = [30, 60, 90];

/** A skip costs 25% of the session's base XP (technical design §4). */
const SKIP_PENALTY_RATE = 0.25;

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    target_duration_minutes: row.target_duration_minutes,
    recurrence_rule: row.recurrence_rule,
    base_xp: row.base_xp,
    is_active: row.is_active,
    virtue_ids: row.virtue_ids,
    created_at: row.created_at.toISOString(),
  };
}

function toInstance(row: SessionInstanceRow): SessionInstance {
  return {
    id: row.id,
    session_id: row.session_id,
    user_id: row.user_id,
    scheduled_at: row.scheduled_at?.toISOString() ?? null,
    started_at: row.started_at?.toISOString() ?? null,
    ended_at: row.ended_at?.toISOString() ?? null,
    actual_duration_seconds: row.actual_duration_seconds,
    status: row.status,
    xp_earned: row.xp_earned,
    skip_penalty_xp: row.skip_penalty_xp,
    focus_mode_activated: row.focus_mode_activated,
  };
}

/**
 * Postgres-backed storage for `public.sessions`, `public.session_virtues`, and
 * `public.session_instances`. The pool connects with a role that bypasses RLS
 * (see `src/api/shared/db.ts`), so every query here filters by `user_id`
 * explicitly instead of relying on the database to enforce ownership.
 */
class SessionStorage {
  config: Config;
  pool: Pool;
  logger: Console;

  constructor(config: Config, dependencies: Pick<Dependencies, 'pool' | 'logger'>) {
    this.config = config;
    this.pool = dependencies.pool;
    this.logger = dependencies.logger;
  }

  async list(userId: string, query: SessionListQuery): Promise<Session[]> {
    const { rows } = await this.pool.query<SessionRow>(
      `select s.id, s.user_id, s.title, s.target_duration_minutes, s.recurrence_rule,
              s.base_xp, s.is_active, s.created_at,
              coalesce(
                array_agg(sv.virtue_id) filter (where sv.virtue_id is not null),
                '{}'
              ) as virtue_ids
         from public.sessions s
         left join public.session_virtues sv on sv.session_id = s.id
        where s.user_id = $1
          and ($2::boolean is null or s.is_active = $2)
        group by s.id
        order by s.created_at desc`,
      [userId, query.isActive ?? null],
    );

    return rows.map(toSession);
  }

  async create(userId: string, input: SessionCreateInput): Promise<Session> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      await this.assertDurationAllowed(client, userId, input.target_duration_minutes);

      // base_xp is left to `sessions_default_xp`, the BEFORE INSERT trigger that
      // fills it from `public.default_session_xp(target_duration_minutes)`, when
      // the caller does not pin one.
      const { rows } = await client.query<SessionRow>(
        `insert into public.sessions
           (user_id, title, target_duration_minutes, recurrence_rule, base_xp)
         values ($1, $2, $3, $4::jsonb, $5)
         returning ${SESSION_COLUMNS}`,
        [
          userId,
          input.title,
          input.target_duration_minutes,
          input.recurrence_rule ? JSON.stringify(input.recurrence_rule) : null,
          input.base_xp ?? null,
        ],
      );
      const session = rows[0];

      await client.query(
        `insert into public.session_virtues (session_id, virtue_id, user_id)
         select $1, unnest($2::uuid[]), $3`,
        [session.id, input.virtue_ids, userId],
      );

      await client.query('commit');

      return toSession({ ...session, virtue_ids: input.virtue_ids });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw this.mapWriteError(err);
    } finally {
      client.release();
    }
  }

  async update(userId: string, sessionId: string, patch: SessionUpdateInput): Promise<Session> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const row = await this.applyScalarUpdate(client, userId, sessionId, patch);
      if (!row) {
        throw new NotFound(`Session with ID ${sessionId} not found`);
      }

      const virtueIds = await this.applyVirtueUpdate(client, userId, sessionId, patch);

      await client.query('commit');
      return toSession({ ...row, virtue_ids: virtueIds });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw this.mapWriteError(err);
    } finally {
      client.release();
    }
  }

  /**
   * `session_virtues` and `session_instances` both cascade from `sessions`, so
   * an in-progress instance is removed along with its definition — ended
   * without scoring, as api-spec.yml describes.
   */
  async delete(userId: string, sessionId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `delete from public.sessions where id = $1 and user_id = $2`,
      [sessionId, userId],
    );

    if (rowCount === 0) {
      throw new NotFound(`Session with ID ${sessionId} not found`);
    }
  }

  async start(userId: string, sessionId: string, focusModeActivated: boolean): Promise<TimerState> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const session = await this.findSession(client, userId, sessionId);
      if (!session) {
        throw new NotFound(`Session with ID ${sessionId} not found`);
      }

      const instance =
        (await this.resumeInProgress(client, userId, sessionId)) ??
        (await this.claimScheduled(client, userId, sessionId, focusModeActivated)) ??
        (await this.createAdHocInstance(client, userId, sessionId, focusModeActivated));

      const { rows } = await client.query<{ now: Date }>(`select now() as now`);

      await client.query('commit');

      return {
        instance: toInstance(instance),
        server_time: rows[0].now.toISOString(),
        target_duration_seconds: session.target_duration_minutes * 60,
      };
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async end(
    userId: string,
    sessionId: string,
    actualDurationSeconds?: number,
  ): Promise<ScoringResult> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const session = await this.findSession(client, userId, sessionId);
      if (!session) {
        throw new NotFound(`Session with ID ${sessionId} not found`);
      }

      const instance = await this.resumeInProgress(client, userId, sessionId);
      if (!instance) {
        throw new Conflict(`Session ${sessionId} has no in-progress instance to end.`);
      }

      const elapsed = await this.elapsedSeconds(client, instance);
      const seconds = actualDurationSeconds ?? elapsed;

      // Ending early earns proportional credit; running over the target does not
      // earn more than finishing it, so the proportion is capped at 1.
      const targetSeconds = session.target_duration_minutes * 60;
      const proportion = Math.min(seconds / targetSeconds, 1);
      const awardedBase = Math.floor(session.base_xp * proportion);

      const result = await this.awardXp(client, {
        userId,
        sourceType: 'session',
        sourceId: sessionId,
        baseXp: awardedBase,
        virtueIds: session.virtue_ids,
        description:
          proportion < 1
            ? `Partial session: ${session.title}`
            : `Session completed: ${session.title}`,
      });

      await client.query(
        `update public.session_instances
            set status = 'completed', ended_at = now(),
                actual_duration_seconds = $1, xp_earned = $2
          where id = $3`,
        [seconds, result.xp_earned, instance.id],
      );

      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async skip(userId: string, sessionId: string): Promise<ScoringResult> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const session = await this.findSession(client, userId, sessionId);
      if (!session) {
        throw new NotFound(`Session with ID ${sessionId} not found`);
      }

      const penalty = Math.floor(session.base_xp * SKIP_PENALTY_RATE);
      await this.markSkipped(client, userId, sessionId, penalty);

      // The penalty is written as a negative ledger row, which
      // `calculate_and_award_xp` deliberately leaves un-multiplied and does not
      // count as activity — so a skip cannot break (or extend) the streak.
      // Virtues are left off: losing XP should not be attributed to one.
      const result = await this.awardXp(client, {
        userId,
        sourceType: 'penalty',
        sourceId: sessionId,
        baseXp: -penalty,
        virtueIds: [],
        description: `Skipped session: ${session.title}`,
      });

      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Loads the session with its virtue tags, locking the row. Every instance
   * transition takes this lock first, so two clients starting the same session
   * at once serialise here rather than each inserting an in-progress instance
   * neither can see in the other's open transaction.
   */
  private async findSession(
    client: PoolClient,
    userId: string,
    sessionId: string,
  ): Promise<(SessionRow & { virtue_ids: string[] }) | null> {
    const { rows } = await client.query<SessionRow>(
      `select ${SESSION_COLUMNS} from public.sessions where id = $1 and user_id = $2
         for update`,
      [sessionId, userId],
    );
    if (rows.length === 0) {
      return null;
    }

    const { rows: virtueRows } = await client.query<{ virtue_id: string }>(
      `select virtue_id from public.session_virtues where session_id = $1`,
      [sessionId],
    );

    return { ...rows[0], virtue_ids: virtueRows.map((row) => row.virtue_id) };
  }

  /** The session's live instance, if it has one. Locked, so a concurrent start/end serialises behind it. */
  private async resumeInProgress(
    client: PoolClient,
    userId: string,
    sessionId: string,
  ): Promise<SessionInstanceRow | null> {
    const { rows } = await client.query<SessionInstanceRow>(
      `select ${INSTANCE_COLUMNS}
         from public.session_instances
        where session_id = $1 and user_id = $2 and status = 'in_progress'
        order by started_at desc
        limit 1
          for update`,
      [sessionId, userId],
    );
    return rows[0] ?? null;
  }

  /**
   * Promotes the pending scheduled instance nearest to now, so starting a
   * recurring session — a little early or a little late — fills its slot
   * instead of leaving it behind as a phantom miss.
   */
  private async claimScheduled(
    client: PoolClient,
    userId: string,
    sessionId: string,
    focusModeActivated: boolean,
  ): Promise<SessionInstanceRow | null> {
    const { rows } = await client.query<SessionInstanceRow>(
      `update public.session_instances
          set status = 'in_progress', started_at = now(), focus_mode_activated = $3
        where id = (
          select id
            from public.session_instances
           where session_id = $1 and user_id = $2 and status = 'scheduled'
           order by abs(extract(epoch from (scheduled_at - now()))) nulls last
           limit 1
             for update
        )
        returning ${INSTANCE_COLUMNS}`,
      [sessionId, userId, focusModeActivated],
    );
    return rows[0] ?? null;
  }

  /** An unscheduled ("start it now") instance. `scheduled_at` stays null, which the slot index ignores. */
  private async createAdHocInstance(
    client: PoolClient,
    userId: string,
    sessionId: string,
    focusModeActivated: boolean,
  ): Promise<SessionInstanceRow> {
    const { rows } = await client.query<SessionInstanceRow>(
      `insert into public.session_instances
         (session_id, user_id, started_at, status, focus_mode_activated)
       values ($1, $2, now(), 'in_progress', $3)
       returning ${INSTANCE_COLUMNS}`,
      [sessionId, userId, focusModeActivated],
    );
    return rows[0];
  }

  /**
   * Seconds since the instance started, measured against the database clock so
   * a client with a skewed clock cannot inflate its own credit.
   */
  private async elapsedSeconds(client: PoolClient, instance: SessionInstanceRow): Promise<number> {
    const { rows } = await client.query<{ elapsed: string }>(
      `select extract(epoch from (now() - $1::timestamptz)) as elapsed`,
      [instance.started_at],
    );
    return Math.max(Math.floor(Number(rows[0].elapsed)), 0);
  }

  /**
   * Marks the pending scheduled instance skipped. A session with no scheduled
   * instance (an ad-hoc one, or a slot the client never expanded) records the
   * skip as a new row, so the penalty is always traceable to an instance.
   */
  private async markSkipped(
    client: PoolClient,
    userId: string,
    sessionId: string,
    penalty: number,
  ): Promise<void> {
    const { rowCount } = await client.query(
      `update public.session_instances
          set status = 'skipped', skip_penalty_xp = $3
        where id = (
          select id
            from public.session_instances
           where session_id = $1 and user_id = $2 and status = 'scheduled'
           order by abs(extract(epoch from (scheduled_at - now()))) nulls last
           limit 1
             for update
        )`,
      [sessionId, userId, penalty],
    );

    if (rowCount === 0) {
      await client.query(
        `insert into public.session_instances
           (session_id, user_id, status, skip_penalty_xp)
         values ($1, $2, 'skipped', $3)`,
        [sessionId, userId, penalty],
      );
    }
  }

  private async awardXp(
    client: PoolClient,
    award: {
      userId: string;
      sourceType: 'session' | 'penalty';
      sourceId: string;
      baseXp: number;
      virtueIds: string[];
      description: string;
    },
  ): Promise<ScoringResult> {
    const { rows } = await client.query<{ result: ScoringResult }>(
      `select public.calculate_and_award_xp(
         $1::uuid, $2::public.xp_source_type, $3::uuid, $4::integer, $5::uuid[], $6::varchar
       ) as result`,
      [
        award.userId,
        award.sourceType,
        award.sourceId,
        award.baseXp,
        award.virtueIds,
        award.description,
      ],
    );
    return rows[0].result;
  }

  /**
   * Gates `target_duration_minutes`, which the OpenAPI schema types only as an
   * integer.
   *
   * A non-positive duration is rejected here rather than left to the
   * `target_duration_minutes > 0` CHECK, so that it reads as the bad request it
   * is instead of falling into the premium branch below — nothing about a
   * subscription makes a zero-minute session valid.
   *
   * Custom durations are a premium feature (api-spec.yml). The
   * live-subscription test mirrors `private.enforce_plan_limit()`: premium is
   * unlimited only while the subscription has not lapsed. A caller with no
   * profile row cannot be premium, so it fails here rather than on the foreign
   * key below.
   */
  private async assertDurationAllowed(
    client: PoolClient,
    userId: string,
    minutes: number,
  ): Promise<void> {
    if (minutes <= 0) {
      throw new BadRequest('target_duration_minutes must be greater than zero.');
    }

    if (STANDARD_DURATION_MINUTES.includes(minutes)) {
      return;
    }

    const { rows } = await client.query<{ premium: boolean }>(
      `select p.subscription_tier = 'premium'
              and (p.subscription_expires_at is null or p.subscription_expires_at > now())
                as premium
         from public.profiles p
        where p.id = $1`,
      [userId],
    );

    if (!rows[0]?.premium) {
      throw new PaymentRequired(
        `A ${minutes}-minute session is a custom duration. Free plan sessions must be ${STANDARD_DURATION_MINUTES.join(', ')} minutes; upgrade to premium for custom durations.`,
      );
    }
  }

  /**
   * Updates only the scalar columns present on `patch`, so an omitted field is
   * left untouched rather than overwritten with a default. Returns null if the
   * session doesn't exist or isn't owned by `userId`; returns the current row
   * unchanged (no UPDATE issued) when `patch` carries no scalar fields at all.
   *
   * `base_xp` is only ever changed when the caller sends it: the default is a
   * BEFORE INSERT trigger, so a session whose duration changes keeps whatever
   * base XP it already had, exactly as a direct PostgREST write would.
   */
  private async applyScalarUpdate(
    client: PoolClient,
    userId: string,
    sessionId: string,
    patch: SessionUpdateInput,
  ): Promise<SessionRow | null> {
    const { rows: currentRows } = await client.query<SessionRow>(
      `select ${SESSION_COLUMNS} from public.sessions where id = $1 and user_id = $2
         for update`,
      [sessionId, userId],
    );
    const current = currentRows[0];
    if (!current) {
      return null;
    }

    if (patch.target_duration_minutes !== undefined) {
      await this.assertDurationAllowed(client, userId, patch.target_duration_minutes);
    }

    const columns: Array<[string, unknown]> = [];
    if (patch.title !== undefined) columns.push(['title', patch.title]);
    if (patch.target_duration_minutes !== undefined) {
      columns.push(['target_duration_minutes', patch.target_duration_minutes]);
    }
    if (patch.recurrence_rule !== undefined) {
      columns.push([
        'recurrence_rule',
        patch.recurrence_rule === null ? null : JSON.stringify(patch.recurrence_rule),
      ]);
    }
    if (patch.base_xp !== undefined) columns.push(['base_xp', patch.base_xp]);
    if (patch.is_active !== undefined) columns.push(['is_active', patch.is_active]);

    if (columns.length === 0) {
      return current;
    }

    const setClause = columns
      .map(([column], index) =>
        column === 'recurrence_rule'
          ? `${column} = $${index + 1}::jsonb`
          : `${column} = $${index + 1}`,
      )
      .join(', ');
    const values = columns.map(([, value]) => value);

    const { rows } = await client.query<SessionRow>(
      `update public.sessions set ${setClause}
        where id = $${values.length + 1} and user_id = $${values.length + 2}
        returning ${SESSION_COLUMNS}`,
      [...values, sessionId, userId],
    );
    return rows[0];
  }

  /** Replaces the session's tagged virtues when `patch.virtue_ids` is present; otherwise returns the current tags. */
  private async applyVirtueUpdate(
    client: PoolClient,
    userId: string,
    sessionId: string,
    patch: SessionUpdateInput,
  ): Promise<string[]> {
    if (patch.virtue_ids === undefined) {
      const { rows } = await client.query<{ virtue_id: string }>(
        `select virtue_id from public.session_virtues where session_id = $1`,
        [sessionId],
      );
      return rows.map((row) => row.virtue_id);
    }

    await client.query(`delete from public.session_virtues where session_id = $1`, [sessionId]);
    await client.query(
      `insert into public.session_virtues (session_id, virtue_id, user_id)
       select $1, unnest($2::uuid[]), $3`,
      [sessionId, patch.virtue_ids, userId],
    );
    return patch.virtue_ids;
  }

  private mapWriteError(err: unknown): Error {
    if (err instanceof ServerError) {
      return err;
    }

    if (isForeignKeyViolation(err)) {
      return new BadRequest('One or more virtue_ids do not exist for this user.');
    }

    if (isUniqueViolation(err)) {
      return new BadRequest('virtue_ids must not contain duplicates.');
    }

    return err as Error;
  }
}

export default SessionStorage;
