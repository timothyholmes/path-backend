import { Pool, PoolConfig } from 'pg';
import { getConfig } from '../src/config';

export type DbMode = 'supabase' | 'bare';

export interface DatabaseConfig {
  url: string;
  poolMax: number;
  statementTimeoutMs: number;
}

/**
 * Resolves the database connection.
 *
 * `DATABASE_URL` wins so CI and one-off scripts can point at a throwaway
 * container without editing config. Otherwise the `database` section of
 * `config/{NODE_ENV}.yml` applies, which means a production connection string
 * can be stored as an `ENC(...)` value and decrypted by ConfigLoader like any
 * other secret.
 */
export function getDatabaseConfig(): DatabaseConfig {
  const config = getConfig();
  const fromFile = (config.database ?? {}) as Partial<DatabaseConfig>;

  const url = process.env.DATABASE_URL ?? fromFile.url;
  if (!url) {
    throw new Error(
      'No database connection configured. Set DATABASE_URL or add a `database.url` to config/{NODE_ENV}.yml',
    );
  }

  return {
    url,
    poolMax: fromFile.poolMax ?? 10,
    statementTimeoutMs: fromFile.statementTimeoutMs ?? 30_000,
  };
}

/**
 * `bare` means a stock PostgreSQL server with no Supabase platform objects, so
 * the compat shim has to be applied before the migrations. `supabase` means a
 * local stack or a hosted project, where applying the shim would be wrong.
 */
export function getDbMode(): DbMode {
  const mode = process.env.PATH_DB_MODE ?? 'supabase';
  if (mode !== 'supabase' && mode !== 'bare') {
    throw new Error(`PATH_DB_MODE must be "supabase" or "bare", got "${mode}"`);
  }
  return mode;
}

export function createPool(overrides: Partial<PoolConfig> = {}): Pool {
  const { url, poolMax, statementTimeoutMs } = getDatabaseConfig();

  return new Pool({
    connectionString: url,
    max: poolMax,
    statement_timeout: statementTimeoutMs,
    ...overrides,
  });
}
