import { Pool } from 'pg';
import { Config, Dependencies } from '../../config';
import {
  Virtue,
  VirtueCreateInput,
  VirtueHistory,
  VirtueHistoryPoint,
  VirtueHistoryQuery,
  VirtueUpdateInput,
} from '../../types';
import { NotFound } from '../../errors/notFound';
import { Conflict } from '../../errors/conflict';
import { BadRequest } from '../../errors/badRequest';
import { PaymentRequired } from '../../errors/paymentRequired';
import { ServerError } from '../../errors/serverError';
import { isPostgresError, isUniqueViolation, parsePlanLimitError } from '../shared/postgresErrors';

interface VirtueRow {
  id: string;
  user_id: string;
  name: string;
  icon: string | null;
  color: string | null;
  xp: number;
  level: number;
  display_order: number;
}

interface HistoryRow {
  date: string;
  xp: number;
  cumulative_xp: number;
  level: number;
}

/** `xp` and `level` are derived from the ledger by `calculate_and_award_xp`, so no write here sets them. */
const VIRTUE_COLUMNS = `id, user_id, name, icon, color, xp, level, display_order`;

const NAME_TAKEN_CONSTRAINT = 'virtues_user_id_name_key';

function toVirtue(row: VirtueRow): Virtue {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    xp: row.xp,
    level: row.level,
    display_order: row.display_order,
  };
}

function toPoint(row: HistoryRow): VirtueHistoryPoint {
  return {
    date: row.date,
    xp: row.xp,
    cumulative_xp: row.cumulative_xp,
    level: row.level,
  };
}

/**
 * Postgres-backed storage for `public.virtues`. The pool connects with a role
 * that bypasses RLS (see `src/api/shared/db.ts`), so every query here filters by
 * `user_id` explicitly instead of relying on the database to enforce ownership.
 */
class VirtueStorage {
  config: Config;
  pool: Pool;
  logger: Console;

  constructor(config: Config, dependencies: Pick<Dependencies, 'pool' | 'logger'>) {
    this.config = config;
    this.pool = dependencies.pool;
    this.logger = dependencies.logger;
  }

  async list(userId: string): Promise<Virtue[]> {
    const { rows } = await this.pool.query<VirtueRow>(
      `select ${VIRTUE_COLUMNS} from public.virtues
        where user_id = $1
        order by display_order, created_at`,
      [userId],
    );

    return rows.map(toVirtue);
  }

  /**
   * Inserts only the columns the caller supplied, so an omitted field falls to
   * the column default (`display_order` is `not null default 0`, which a literal
   * NULL would violate rather than default).
   */
  async create(userId: string, input: VirtueCreateInput): Promise<Virtue> {
    const columns: Array<[string, unknown]> = [
      ['user_id', userId],
      ['name', input.name],
    ];
    if (input.icon !== undefined) columns.push(['icon', input.icon]);
    if (input.color !== undefined) columns.push(['color', input.color]);
    if (input.display_order !== undefined) columns.push(['display_order', input.display_order]);

    try {
      const { rows } = await this.pool.query<VirtueRow>(
        `insert into public.virtues (${columns.map(([column]) => column).join(', ')})
         values (${columns.map((_, index) => `$${index + 1}`).join(', ')})
         returning ${VIRTUE_COLUMNS}`,
        columns.map(([, value]) => value),
      );
      return toVirtue(rows[0]);
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  /**
   * Updates only the columns present on `patch`, so an omitted field is left
   * untouched rather than overwritten with a default. A patch with no fields at
   * all issues no UPDATE and returns the virtue unchanged.
   */
  async update(userId: string, virtueId: string, patch: VirtueUpdateInput): Promise<Virtue> {
    const columns: Array<[string, unknown]> = [];
    if (patch.name !== undefined) columns.push(['name', patch.name]);
    if (patch.icon !== undefined) columns.push(['icon', patch.icon]);
    if (patch.color !== undefined) columns.push(['color', patch.color]);
    if (patch.display_order !== undefined) columns.push(['display_order', patch.display_order]);

    if (columns.length === 0) {
      return this.getById(userId, virtueId);
    }

    const setClause = columns.map(([column], index) => `${column} = $${index + 1}`).join(', ');
    const values = columns.map(([, value]) => value);

    try {
      const { rows } = await this.pool.query<VirtueRow>(
        `update public.virtues set ${setClause}
          where id = $${values.length + 1} and user_id = $${values.length + 2}
          returning ${VIRTUE_COLUMNS}`,
        [...values, virtueId, userId],
      );

      if (rows.length === 0) {
        throw new NotFound(`Virtue with ID ${virtueId} not found`);
      }
      return toVirtue(rows[0]);
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  /**
   * Untagging is all cascade: `routine_virtues`, `goal_virtues`,
   * `session_virtues`, and `field_log_virtues` drop their rows, and
   * `goal_backlog.virtue_id` is set to null. Ledger rows survive with a null
   * `virtue_id` (see the `retain_xp_ledger_on_virtue_delete` migration) because
   * the ledger records what happened, not what still exists — which also keeps
   * `profiles.global_xp` reconcilable against it.
   */
  async delete(userId: string, virtueId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `delete from public.virtues where id = $1 and user_id = $2`,
      [virtueId, userId],
    );

    if (rowCount === 0) {
      throw new NotFound(`Virtue with ID ${virtueId} not found`);
    }
  }

  async getById(userId: string, virtueId: string): Promise<Virtue> {
    const { rows } = await this.pool.query<VirtueRow>(
      `select ${VIRTUE_COLUMNS} from public.virtues where id = $1 and user_id = $2`,
      [virtueId, userId],
    );

    if (rows.length === 0) {
      throw new NotFound(`Virtue with ID ${virtueId} not found`);
    }
    return toVirtue(rows[0]);
  }

  /**
   * Daily XP for one virtue, for charting.
   *
   * Days are bucketed in the user's own timezone, the same way
   * `daily_activity` and the streak logic bucket them, so a point lines up with
   * the day the user experienced. Only days with ledger activity get a point;
   * `date` is explicit on every point, so a chart can render the gaps however it
   * likes rather than paying for a row per empty day.
   *
   * `cumulative_xp` is the all-time total through that day, not the total within
   * the window, so `level` is the level the user actually held — and a windowed
   * request stays consistent with an unwindowed one. XP earned before `from` is
   * therefore summed into a baseline rather than dropped.
   */
  async history(
    userId: string,
    virtueId: string,
    query: VirtueHistoryQuery,
  ): Promise<VirtueHistory> {
    const virtue = await this.getById(userId, virtueId);

    try {
      const { rows } = await this.pool.query<HistoryRow>(
        `with daily as (
           select (l.created_at at time zone p.timezone)::date as day,
                  sum(l.final_xp)::integer as xp
             from public.xp_ledger l
             join public.profiles p on p.id = l.user_id
            where l.user_id = $1 and l.virtue_id = $2
            group by 1
         ),
         baseline as (
           select coalesce(sum(d.xp), 0)::integer as xp
             from daily d
            where $3::date is not null and d.day < $3::date
         ),
         windowed as (
           select d.day::text as date,
                  d.xp,
                  (b.xp + sum(d.xp) over (order by d.day))::integer as cumulative_xp
             from daily d cross join baseline b
            where ($3::date is null or d.day >= $3::date)
              and ($4::date is null or d.day <= $4::date)
         )
         select w.date, w.xp, w.cumulative_xp, public.level_for_xp(w.cumulative_xp) as level
           from windowed w
          order by w.date`,
        [userId, virtueId, query.from ?? null, query.to ?? null],
      );

      return { virtue_id: virtue.id, points: rows.map(toPoint) };
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  private mapWriteError(err: unknown): Error {
    if (err instanceof ServerError) {
      return err;
    }

    const planLimit = parsePlanLimitError(err);
    if (planLimit?.table === 'virtues') {
      return new PaymentRequired(
        `Free plan allows at most ${planLimit.limit} virtues. Delete one, or upgrade to premium for unlimited virtues.`,
      );
    }

    // `virtues` has exactly one unique constraint a caller can trip, and
    // api-spec.yml answers it with a 409 on both create and update.
    if (isUniqueViolation(err, NAME_TAKEN_CONSTRAINT)) {
      return new Conflict('A virtue with this name already exists.');
    }

    // The remaining classes are all "the client sent something the column
    // cannot hold". `express-openapi-validator` does not enforce request-body
    // schemas against this OpenAPI 3.1 document (a missing `name`, a colour that
    // is not a hex triplet and a malformed uuid all reach the database), so
    // these are mapped here rather than left to surface as a 500.
    if (isPostgresError(err)) {
      if (err.code === '23514') {
        return new BadRequest('color must be a hex triplet such as #3D7EE5.');
      }
      if (err.code === '23502') {
        return new BadRequest(`${err.column ?? 'A required field'} is required.`);
      }
      if (err.code === '22001') {
        return new BadRequest('A supplied value is longer than the column allows.');
      }
      if (err.code === '22P02') {
        return new BadRequest('A supplied value is not a valid uuid, date, or integer.');
      }
      // 22007/22008: a syntactically valid string that is not a date ("2026-02-30").
      if (err.code === '22007' || err.code === '22008') {
        return new BadRequest('from and to must be valid calendar dates.');
      }
    }

    return err as Error;
  }
}

export default VirtueStorage;
