import { Pool } from 'pg';
import { Config } from '../../config';

/**
 * Builds the connection pool Postgres-backed storage classes depend on. The
 * pool connects with whatever role `database.url` names (the `postgres`
 * superuser locally and in CI's bare-Postgres job), which bypasses Row Level
 * Security entirely — RLS is the boundary for the mobile client querying
 * PostgREST directly, not for this trusted backend. Storage classes must
 * therefore filter every query by `user_id` themselves, mirroring the RLS
 * policies rather than relying on them.
 */
export function createDbPool(config: Config): Pool {
  const database = config.database;
  if (!database?.url) {
    throw new Error(
      'database.url must be configured to use Postgres-backed storage (set DATABASE_URL or config/{NODE_ENV}.yml database.url)',
    );
  }

  return new Pool({
    connectionString: database.url,
    max: database.poolMax ?? 10,
    statement_timeout: database.statementTimeoutMs ?? 30_000,
  });
}
