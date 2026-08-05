import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { DbMode, getDatabaseConfig, getDbMode } from './client';

export const MIGRATIONS_DIR = path.resolve(__dirname, '../supabase/migrations');
export const SHIM_PATH = path.resolve(__dirname, 'compat/0000_supabase_shim.sql');

export interface Migration {
  version: string;
  name: string;
  filename: string;
  sql: string;
}

export interface MigrateResult {
  mode: DbMode;
  applied: string[];
  alreadyApplied: string[];
}

const FILENAME_PATTERN = /^(\d+)_(.+)\.sql$/;

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }

  return fs
    .readdirSync(dir)
    .filter((filename) => filename.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const match = FILENAME_PATTERN.exec(filename);
      if (!match) {
        throw new Error(
          `Migration filenames must be <version>_<name>.sql (as produced by \`supabase migration new\`), got: ${filename}`,
        );
      }

      return {
        version: match[1],
        name: match[2],
        filename,
        sql: fs.readFileSync(path.join(dir, filename), 'utf8'),
      };
    });
}

/**
 * Creates the ledger the Supabase CLI uses, with the same schema, table, and
 * column names. Both this runner and `supabase db push` then read and write the
 * same record of what has been applied, so the two can be used interchangeably
 * against the same database.
 */
async function ensureLedger(client: Client): Promise<void> {
  await client.query('create schema if not exists supabase_migrations');
  await client.query(
    'create table if not exists supabase_migrations.schema_migrations (version text not null primary key)',
  );
  await client.query(
    'alter table supabase_migrations.schema_migrations add column if not exists statements text[]',
  );
  await client.query(
    'alter table supabase_migrations.schema_migrations add column if not exists name text',
  );
}

async function appliedVersions(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ version: string }>(
    'select version from supabase_migrations.schema_migrations',
  );
  return new Set(rows.map((row) => row.version));
}

export async function applyShim(client: Client, shimPath: string = SHIM_PATH): Promise<void> {
  const sql = fs.readFileSync(shimPath, 'utf8');
  await client.query(sql);
}

export async function migrate(options: {
  client: Client;
  mode?: DbMode;
  migrationsDir?: string;
  log?: (message: string) => void;
}): Promise<MigrateResult> {
  const { client } = options;
  const mode = options.mode ?? getDbMode();
  const log = options.log ?? (() => {});

  // On a stock PostgreSQL server the auth schema, auth.uid(), and the PostgREST
  // roles do not exist, and every migration below would fail on the first
  // reference to them.
  if (mode === 'bare') {
    log('applying Supabase compat shim');
    await applyShim(client);
  }

  await ensureLedger(client);

  const already = await appliedVersions(client);
  const migrations = loadMigrations(options.migrationsDir);
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of migrations) {
    if (already.has(migration.version)) {
      alreadyApplied.push(migration.version);
      continue;
    }

    log(`applying ${migration.filename}`);

    // One transaction per migration: a failure leaves the database at the last
    // complete migration rather than half-way through a broken one.
    await client.query('begin');
    try {
      await client.query(migration.sql);
      await client.query(
        `insert into supabase_migrations.schema_migrations (version, name, statements)
         values ($1, $2, $3)
         on conflict (version) do nothing`,
        // The CLI stores individually split statements here. Splitting SQL
        // correctly requires a real parser (dollar-quoted function bodies in
        // particular), and nothing reads this column to decide what to apply --
        // `version` is the key. The whole file is stored as one element.
        [migration.version, migration.name, [migration.sql]],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw new Error(`Migration ${migration.filename} failed: ${(error as Error).message}`);
    }

    applied.push(migration.version);
  }

  return { mode, applied, alreadyApplied };
}

export async function main(): Promise<void> {
  const mode = getDbMode();
  const { url, statementTimeoutMs } = getDatabaseConfig();
  const client = new Client({ connectionString: url, statement_timeout: statementTimeoutMs });

  await client.connect();
  try {
    const result = await migrate({
      client,
      mode,
      log: (message) => console.log(`[migrate] ${message}`),
    });

    if (result.applied.length === 0) {
      console.log(
        `[migrate] up to date (${result.alreadyApplied.length} migrations, mode=${mode})`,
      );
    } else {
      console.log(`[migrate] applied ${result.applied.length} migration(s), mode=${mode}`);
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error: Error) => {
    console.error(`[migrate] ${error.message}`);
    process.exit(1);
  });
}
