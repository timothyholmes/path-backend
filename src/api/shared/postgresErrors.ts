/** A `pg` driver error, which decorates `Error` with fields from the Postgres wire protocol. */
export interface PostgresError extends Error {
  code?: string;
  detail?: string;
  constraint?: string;
  table?: string;
}

export function isPostgresError(err: unknown): err is PostgresError {
  return err instanceof Error && typeof (err as PostgresError).code === 'string';
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  return (
    isPostgresError(err) && err.code === '23505' && (!constraint || err.constraint === constraint)
  );
}

export function isForeignKeyViolation(err: unknown, constraint?: string): boolean {
  return (
    isPostgresError(err) && err.code === '23503' && (!constraint || err.constraint === constraint)
  );
}

export function isCheckViolation(err: unknown, constraint?: string): boolean {
  return (
    isPostgresError(err) && err.code === '23514' && (!constraint || err.constraint === constraint)
  );
}

export interface PlanLimitExceeded {
  table: string;
  limit: number;
}

/**
 * Parses the `plan_limit_exceeded:<table>:<limit>` detail raised by
 * `private.enforce_plan_limit()` (see `supabase/migrations/*_plan_limits.sql`).
 * Returns null for any other error, including other `P0001` raises.
 */
export function parsePlanLimitError(err: unknown): PlanLimitExceeded | null {
  if (!isPostgresError(err) || err.code !== 'P0001' || !err.detail) {
    return null;
  }

  const match = /^plan_limit_exceeded:([^:]+):(\d+)$/.exec(err.detail);
  if (!match) {
    return null;
  }

  return { table: match[1], limit: Number(match[2]) };
}
