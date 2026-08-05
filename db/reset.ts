import { Client } from 'pg';
import { getDatabaseConfig, getDbMode } from './client';
import { migrate } from './migrate';

/**
 * Drops and rebuilds the schema, then re-applies every migration.
 *
 * This is the bare-Postgres counterpart to `supabase db reset`. Against a
 * Supabase database the CLI command should be used instead -- it also resets
 * auth, storage, and realtime, which this cannot.
 */
export async function reset(client: Client, log: (message: string) => void = () => {}) {
  log('dropping schemas');

  // Order matters only in that public is recreated afterwards; cascade handles
  // the dependencies between them.
  await client.query(`
    drop schema if exists private cascade;
    drop schema if exists supabase_migrations cascade;
    drop schema if exists auth cascade;
    drop schema if exists public cascade;
    create schema public;
    grant all on schema public to public;
  `);

  return migrate({ client, log });
}

function assertSafeTarget(url: string, force: boolean): void {
  if (force) return;

  const host = new URL(url).hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';

  if (!isLocal) {
    throw new Error(
      `Refusing to reset a non-local database (${host}). Re-run with --force if this is intentional.`,
    );
  }

  if (getDbMode() !== 'bare') {
    throw new Error(
      'Refusing to reset with PATH_DB_MODE=supabase. Use `npm run db:reset` (the Supabase CLI) for a Supabase database, or set PATH_DB_MODE=bare.',
    );
  }
}

export async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const { url, statementTimeoutMs } = getDatabaseConfig();

  assertSafeTarget(url, force);

  const client = new Client({ connectionString: url, statement_timeout: statementTimeoutMs });
  await client.connect();

  try {
    const result = await reset(client, (message) => console.log(`[reset] ${message}`));
    console.log(`[reset] applied ${result.applied.length} migration(s)`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error: Error) => {
    console.error(`[reset] ${error.message}`);
    process.exit(1);
  });
}
