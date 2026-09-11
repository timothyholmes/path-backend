import { Pool, PoolClient } from 'pg';
import { Config, Dependencies } from '../../config';
import {
  BacklogItem,
  BacklogItemCreateInput,
  BacklogItemUpdateInput,
  BacklogPromoteInput,
  Goal,
  GoalCreateInput,
  GoalListQuery,
  GoalUpdateInput,
  ScoringResult,
} from '../../types';
import { NotFound } from '../../errors/notFound';
import { Conflict } from '../../errors/conflict';
import { BadRequest } from '../../errors/badRequest';
import { PaymentRequired } from '../../errors/paymentRequired';
import { ServerError } from '../../errors/serverError';
import { isPostgresError, isUniqueViolation, parsePlanLimitError } from '../shared/postgresErrors';

interface GoalRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  is_quest: boolean;
  status: Goal['status'];
  due_date: string | null;
  base_xp: number;
  parent_goal_id: string | null;
  display_order: number;
  completed_at: Date | null;
  created_at: Date;
  virtue_ids: string[];
}

interface BacklogRow {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  source: BacklogItem['source'];
  source_id: string | null;
  virtue_id: string | null;
  promoted_to_goal_id: string | null;
  created_at: Date;
}

/**
 * `due_date` is a `date`, which the driver would otherwise hand back as a JS
 * Date at the *local* midnight — one day off for anyone west of UTC. Casting to
 * text in SQL keeps the calendar date the user chose.
 */
const GOAL_COLUMNS = `id, user_id, title, description, is_quest, status, due_date::text as due_date,
                      base_xp, parent_goal_id, display_order, completed_at, created_at`;

const BACKLOG_COLUMNS = `id, user_id, title, notes, source, source_id, virtue_id,
                         promoted_to_goal_id, created_at`;

/**
 * A quest is a goal with a bigger arc, and api-spec.yml promises it "awards a
 * bonus over standard goals". The database has no notion of a quest when
 * scoring, so the bonus is applied to the base XP handed to
 * `calculate_and_award_xp` — the streak multiplier and virtue bonus still come
 * from the function, which keeps a quest's completion multiplied like any other.
 */
const QUEST_BONUS_RATE = 0.5;

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    description: row.description,
    is_quest: row.is_quest,
    status: row.status,
    due_date: row.due_date,
    base_xp: row.base_xp,
    parent_goal_id: row.parent_goal_id,
    display_order: row.display_order,
    virtue_ids: row.virtue_ids,
    completed_at: row.completed_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

function toBacklogItem(row: BacklogRow): BacklogItem {
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    notes: row.notes,
    source: row.source,
    source_id: row.source_id,
    virtue_id: row.virtue_id,
    promoted_to_goal_id: row.promoted_to_goal_id,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Postgres-backed storage for `public.goals`, `public.goal_virtues`, and
 * `public.goal_backlog`. The pool connects with a role that bypasses RLS (see
 * `src/api/shared/db.ts`), so every query here filters by `user_id` explicitly
 * instead of relying on the database to enforce ownership.
 */
class GoalStorage {
  config: Config;
  pool: Pool;
  logger: Console;

  constructor(config: Config, dependencies: Pick<Dependencies, 'pool' | 'logger'>) {
    this.config = config;
    this.pool = dependencies.pool;
    this.logger = dependencies.logger;
  }

  async list(userId: string, query: GoalListQuery): Promise<Goal[]> {
    try {
      return await this.runList(userId, query);
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  private async runList(userId: string, query: GoalListQuery): Promise<Goal[]> {
    const { rows } = await this.pool.query<GoalRow>(
      `select g.id, g.user_id, g.title, g.description, g.is_quest, g.status,
              g.due_date::text as due_date, g.base_xp, g.parent_goal_id, g.display_order,
              g.completed_at, g.created_at,
              coalesce(
                array_agg(gv.virtue_id) filter (where gv.virtue_id is not null),
                '{}'
              ) as virtue_ids
         from public.goals g
         left join public.goal_virtues gv on gv.goal_id = g.id
        where g.user_id = $1
          and ($2::public.goal_status is null or g.status = $2)
          and ($3::boolean is null or g.is_quest = $3)
          and case
                when $4::uuid is null then g.parent_goal_id is null
                else g.parent_goal_id = $4
              end
        group by g.id
        order by g.display_order, g.created_at desc`,
      [userId, query.status ?? null, query.isQuest ?? null, query.parentGoalId ?? null],
    );

    return rows.map(toGoal);
  }

  async create(userId: string, input: GoalCreateInput): Promise<Goal> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const goal = await this.insertGoal(client, userId, input);
      const virtueIds = input.virtue_ids ?? [];
      await this.insertVirtues(client, userId, goal.id, virtueIds);

      await client.query('commit');

      return toGoal({ ...goal, virtue_ids: virtueIds });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw this.mapWriteError(err);
    } finally {
      client.release();
    }
  }

  async update(userId: string, goalId: string, patch: GoalUpdateInput): Promise<Goal> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const row = await this.applyScalarUpdate(client, userId, goalId, patch);
      if (!row) {
        throw new NotFound(`Goal with ID ${goalId} not found`);
      }

      const virtueIds = await this.applyVirtueUpdate(client, userId, goalId, patch);

      await client.query('commit');
      return toGoal({ ...row, virtue_ids: virtueIds });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw this.mapWriteError(err);
    } finally {
      client.release();
    }
  }

  /**
   * Virtue tags and subtasks both cascade from `goals`, so deleting a goal
   * takes its whole subtree with it, as api-spec.yml describes. A backlog item
   * that was promoted into this goal survives with a null `promoted_to_goal_id`
   * (the FK is ON DELETE SET NULL), which makes it promotable again.
   */
  async delete(userId: string, goalId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `delete from public.goals where id = $1 and user_id = $2`,
      [goalId, userId],
    );

    if (rowCount === 0) {
      throw new NotFound(`Goal with ID ${goalId} not found`);
    }
  }

  async complete(userId: string, goalId: string): Promise<ScoringResult> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const goal = await this.findGoal(client, userId, goalId);
      if (!goal) {
        throw new NotFound(`Goal with ID ${goalId} not found`);
      }
      if (goal.status === 'completed') {
        throw new Conflict(`Goal ${goalId} is already completed.`);
      }

      const award = await this.resolveAward(client, goal);

      await client.query(
        `update public.goals set status = 'completed', completed_at = now()
          where id = $1 and user_id = $2`,
        [goalId, userId],
      );

      const { rows } = await client.query<{ result: ScoringResult }>(
        `select public.calculate_and_award_xp(
           $1::uuid, 'goal'::public.xp_source_type, $2::uuid, $3::integer, $4::uuid[], $5::varchar
         ) as result`,
        [userId, award.sourceId, award.baseXp, award.virtueIds, award.description],
      );

      await client.query('commit');
      return rows[0].result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw this.mapWriteError(err);
    } finally {
      client.release();
    }
  }

  async listBacklog(userId: string): Promise<BacklogItem[]> {
    const { rows } = await this.pool.query<BacklogRow>(
      `select ${BACKLOG_COLUMNS}
         from public.goal_backlog
        where user_id = $1 and promoted_to_goal_id is null
        order by created_at desc`,
      [userId],
    );

    return rows.map(toBacklogItem);
  }

  async createBacklogItem(userId: string, input: BacklogItemCreateInput): Promise<BacklogItem> {
    try {
      const { rows } = await this.pool.query<BacklogRow>(
        `insert into public.goal_backlog (user_id, title, notes, source, source_id, virtue_id)
         values ($1, $2, $3, coalesce($4::public.backlog_source, 'manual'), $5, $6)
         returning ${BACKLOG_COLUMNS}`,
        [
          userId,
          input.title,
          input.notes ?? null,
          input.source ?? null,
          input.source_id ?? null,
          input.virtue_id ?? null,
        ],
      );
      return toBacklogItem(rows[0]);
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  async updateBacklogItem(
    userId: string,
    itemId: string,
    patch: BacklogItemUpdateInput,
  ): Promise<BacklogItem> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const current = await this.findBacklogItem(client, userId, itemId);
      if (!current) {
        throw new NotFound(`Backlog item with ID ${itemId} not found`);
      }
      // api-spec.yml scopes this operation to "an unpromoted backlog idea" and
      // sends the caller to PATCH /goals/{id} once it has been promoted. The
      // operation has no 409, so the refusal is a 400.
      if (current.promoted_to_goal_id) {
        throw new BadRequest(
          `Backlog item ${itemId} was already promoted to goal ${current.promoted_to_goal_id}; edit that goal instead.`,
        );
      }

      const columns: Array<[string, unknown]> = [];
      if (patch.title !== undefined) columns.push(['title', patch.title]);
      if (patch.notes !== undefined) columns.push(['notes', patch.notes]);
      if (patch.virtue_id !== undefined) columns.push(['virtue_id', patch.virtue_id]);

      if (columns.length === 0) {
        await client.query('commit');
        return toBacklogItem(current);
      }

      const setClause = columns.map(([column], index) => `${column} = $${index + 1}`).join(', ');
      const values = columns.map(([, value]) => value);

      const { rows } = await client.query<BacklogRow>(
        `update public.goal_backlog set ${setClause}
          where id = $${values.length + 1} and user_id = $${values.length + 2}
          returning ${BACKLOG_COLUMNS}`,
        [...values, itemId, userId],
      );

      await client.query('commit');
      return toBacklogItem(rows[0]);
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw this.mapWriteError(err);
    } finally {
      client.release();
    }
  }

  /** Promotion does not delete the item, so this is how an idea is dismissed for good. */
  async deleteBacklogItem(userId: string, itemId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `delete from public.goal_backlog where id = $1 and user_id = $2`,
      [itemId, userId],
    );

    if (rowCount === 0) {
      throw new NotFound(`Backlog item with ID ${itemId} not found`);
    }
  }

  /**
   * Turns an idea into an active goal and stamps the item with the goal's id.
   * The item is locked first, so two clients promoting the same idea at once
   * serialise here rather than each creating a goal: without the lock neither
   * transaction can see the other's uncommitted `promoted_to_goal_id`.
   */
  async promoteBacklogItem(
    userId: string,
    itemId: string,
    overrides: BacklogPromoteInput,
  ): Promise<Goal> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const item = await this.findBacklogItem(client, userId, itemId, { lock: true });
      if (!item) {
        throw new NotFound(`Backlog item with ID ${itemId} not found`);
      }
      if (item.promoted_to_goal_id) {
        throw new Conflict(
          `Backlog item ${itemId} was already promoted to goal ${item.promoted_to_goal_id}.`,
        );
      }

      const virtueIds = item.virtue_id ? [item.virtue_id] : [];
      const goal = await this.insertGoal(client, userId, {
        title: item.title,
        status: 'active',
        ...(item.notes !== null && { description: item.notes }),
        ...(overrides.is_quest !== undefined && { is_quest: overrides.is_quest }),
        ...(overrides.due_date !== undefined && { due_date: overrides.due_date }),
        ...(overrides.base_xp !== undefined && { base_xp: overrides.base_xp }),
      });
      await this.insertVirtues(client, userId, goal.id, virtueIds);

      await client.query(
        `update public.goal_backlog set promoted_to_goal_id = $1 where id = $2 and user_id = $3`,
        [goal.id, itemId, userId],
      );

      await client.query('commit');
      return toGoal({ ...goal, virtue_ids: virtueIds });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw this.mapWriteError(err);
    } finally {
      client.release();
    }
  }

  /**
   * Inserts only the columns the caller supplied, so an omitted field falls to
   * the column default (`base_xp` is `not null default 150`, which a literal
   * NULL would violate rather than default).
   *
   * `completed_at` is derived from `status` rather than taken from the caller:
   * `goals_completed_at_matches_status` requires the two to agree, and neither
   * GoalCreate nor GoalUpdate exposes the timestamp. Note that arriving at
   * `completed` this way is bookkeeping only — XP is awarded exclusively by
   * `complete()`, exactly as a direct PostgREST write would behave.
   */
  private async insertGoal(
    client: PoolClient,
    userId: string,
    input: GoalCreateInput,
  ): Promise<GoalRow> {
    const columns: Array<[string, unknown]> = [
      ['user_id', userId],
      ['title', input.title],
    ];
    if (input.description !== undefined) columns.push(['description', input.description]);
    if (input.is_quest !== undefined) columns.push(['is_quest', input.is_quest]);
    if (input.status !== undefined) columns.push(['status', input.status]);
    if (input.due_date !== undefined) columns.push(['due_date', input.due_date]);
    if (input.base_xp !== undefined) columns.push(['base_xp', input.base_xp]);
    if (input.parent_goal_id !== undefined) columns.push(['parent_goal_id', input.parent_goal_id]);

    const names = columns.map(([column]) => column);
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    if (input.status === 'completed') {
      names.push('completed_at');
      placeholders.push('now()');
    }

    const { rows } = await client.query<GoalRow>(
      `insert into public.goals (${names.join(', ')})
       values (${placeholders.join(', ')})
       returning ${GOAL_COLUMNS}`,
      columns.map(([, value]) => value),
    );
    return rows[0];
  }

  private async insertVirtues(
    client: PoolClient,
    userId: string,
    goalId: string,
    virtueIds: string[],
  ): Promise<void> {
    if (virtueIds.length === 0) {
      return;
    }

    await client.query(
      `insert into public.goal_virtues (goal_id, virtue_id, user_id)
       select $1, unnest($2::uuid[]), $3`,
      [goalId, virtueIds, userId],
    );
  }

  /** Loads the goal with its virtue tags, locking the row so concurrent completions serialise. */
  private async findGoal(
    client: PoolClient,
    userId: string,
    goalId: string,
  ): Promise<(GoalRow & { virtue_ids: string[] }) | null> {
    const { rows } = await client.query<GoalRow>(
      `select ${GOAL_COLUMNS} from public.goals where id = $1 and user_id = $2
         for update`,
      [goalId, userId],
    );
    if (rows.length === 0) {
      return null;
    }

    return { ...rows[0], virtue_ids: await this.virtueIds(client, goalId) };
  }

  private async virtueIds(client: PoolClient, goalId: string): Promise<string[]> {
    const { rows } = await client.query<{ virtue_id: string }>(
      `select virtue_id from public.goal_virtues where goal_id = $1`,
      [goalId],
    );
    return rows.map((row) => row.virtue_id);
  }

  private async findBacklogItem(
    client: PoolClient,
    userId: string,
    itemId: string,
    options: { lock?: boolean } = {},
  ): Promise<BacklogRow | null> {
    const { rows } = await client.query<BacklogRow>(
      `select ${BACKLOG_COLUMNS} from public.goal_backlog where id = $1 and user_id = $2
         ${options.lock ? 'for update' : ''}`,
      [itemId, userId],
    );
    return rows[0] ?? null;
  }

  /**
   * Decides what a completion is worth and what it is attributed to.
   *
   * A subtask's XP belongs to the goal it serves: the ledger row points at the
   * parent and, when the subtask carries no virtue tags of its own, inherits
   * the parent's — which is how the seeded scenarios record subtask
   * completions (`db/seed/scenarios/activeFree.ts`). Keep the descriptions in
   * step with those scenarios if either side changes.
   */
  private async resolveAward(
    client: PoolClient,
    goal: GoalRow & { virtue_ids: string[] },
  ): Promise<{ sourceId: string; baseXp: number; virtueIds: string[]; description: string }> {
    const baseXp = goal.is_quest ? Math.floor(goal.base_xp * (1 + QUEST_BONUS_RATE)) : goal.base_xp;

    if (!goal.parent_goal_id) {
      return {
        sourceId: goal.id,
        baseXp,
        virtueIds: goal.virtue_ids,
        description: `${goal.is_quest ? 'Quest' : 'Goal'} completed: ${goal.title}`,
      };
    }

    const virtueIds =
      goal.virtue_ids.length > 0
        ? goal.virtue_ids
        : await this.virtueIds(client, goal.parent_goal_id);

    return {
      sourceId: goal.parent_goal_id,
      baseXp,
      virtueIds,
      description: `Subtask completed: ${goal.title}`,
    };
  }

  /**
   * Updates only the scalar columns present on `patch`, so an omitted field is
   * left untouched rather than overwritten with a default. Returns null if the
   * goal doesn't exist or isn't owned by `userId`; returns the current row
   * unchanged (no UPDATE issued) when `patch` carries no scalar fields at all.
   */
  private async applyScalarUpdate(
    client: PoolClient,
    userId: string,
    goalId: string,
    patch: GoalUpdateInput,
  ): Promise<GoalRow | null> {
    const { rows: currentRows } = await client.query<GoalRow>(
      `select ${GOAL_COLUMNS} from public.goals where id = $1 and user_id = $2
         for update`,
      [goalId, userId],
    );
    const current = currentRows[0];
    if (!current) {
      return null;
    }

    const columns: Array<[string, unknown]> = [];
    if (patch.title !== undefined) columns.push(['title', patch.title]);
    if (patch.description !== undefined) columns.push(['description', patch.description]);
    if (patch.is_quest !== undefined) columns.push(['is_quest', patch.is_quest]);
    if (patch.status !== undefined) columns.push(['status', patch.status]);
    if (patch.due_date !== undefined) columns.push(['due_date', patch.due_date]);
    if (patch.display_order !== undefined) columns.push(['display_order', patch.display_order]);

    const assignments = columns.map(([column], index) => `${column} = $${index + 1}`);

    // Mirrors `goals_completed_at_matches_status`, which a partial update would
    // otherwise trip: a status change has to carry the timestamp with it. The
    // stamp is left alone when the goal is already completed, so re-sending
    // `status: "completed"` does not quietly move the completion date.
    if (patch.status !== undefined && patch.status !== current.status) {
      assignments.push(
        patch.status === 'completed' ? 'completed_at = now()' : 'completed_at = null',
      );
    }

    if (assignments.length === 0) {
      return current;
    }

    const values = columns.map(([, value]) => value);
    const { rows } = await client.query<GoalRow>(
      `update public.goals set ${assignments.join(', ')}
        where id = $${values.length + 1} and user_id = $${values.length + 2}
        returning ${GOAL_COLUMNS}`,
      [...values, goalId, userId],
    );
    return rows[0];
  }

  /** Replaces the goal's tagged virtues when `patch.virtue_ids` is present; otherwise returns the current tags. */
  private async applyVirtueUpdate(
    client: PoolClient,
    userId: string,
    goalId: string,
    patch: GoalUpdateInput,
  ): Promise<string[]> {
    if (patch.virtue_ids === undefined) {
      return this.virtueIds(client, goalId);
    }

    await client.query(`delete from public.goal_virtues where goal_id = $1`, [goalId]);
    await this.insertVirtues(client, userId, goalId, patch.virtue_ids);
    return patch.virtue_ids;
  }

  private mapWriteError(err: unknown): Error {
    if (err instanceof ServerError) {
      return err;
    }

    const planLimit = parsePlanLimitError(err);
    if (planLimit?.table === 'goals') {
      return new PaymentRequired(
        `Free plan allows at most ${planLimit.limit} active goals. Complete, archive, or delete one, or upgrade to premium for unlimited goals.`,
      );
    }

    if (isPostgresError(err) && err.code === '23503') {
      // Each table has exactly one FK a caller-supplied id can break: the
      // parent goal on `goals`, the virtue on `goal_backlog`, the virtues on
      // `goal_virtues` — so the failing table names the id they got wrong.
      if (err.table === 'goals') {
        return new BadRequest('parent_goal_id does not exist for this user.');
      }
      return err.table === 'goal_backlog'
        ? new BadRequest('virtue_id does not exist for this user.')
        : new BadRequest('One or more virtue_ids do not exist for this user.');
    }

    if (isUniqueViolation(err)) {
      return new BadRequest('virtue_ids must not contain duplicates.');
    }

    // 22007/22008: a syntactically valid string that is not a date ("2026-02-30").
    if (isPostgresError(err) && (err.code === '22007' || err.code === '22008')) {
      return new BadRequest('due_date is not a valid calendar date.');
    }

    // The remaining classes are all "the client sent something the column
    // cannot hold". `express-openapi-validator` does not enforce request-body
    // schemas against this OpenAPI 3.1 document (a missing `title`, a status
    // outside the enum and a malformed uuid all reach the database), so these
    // are mapped here rather than left to surface as a 500.
    if (isPostgresError(err)) {
      if (err.code === '23502') {
        return new BadRequest(`${err.column ?? 'A required field'} is required.`);
      }
      if (err.code === '22001') {
        return new BadRequest('A supplied value is longer than the column allows.');
      }
      if (err.code === '22P02') {
        return new BadRequest('A supplied value is not a valid uuid or enum member.');
      }
    }

    return err as Error;
  }
}

export default GoalStorage;
