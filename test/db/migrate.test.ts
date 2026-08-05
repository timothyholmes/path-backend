import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { loadMigrations, migrate } from '../../db/migrate';
import { TempDatabase, createTempDatabase, hasDatabase, scalar } from './helpers';

describe('loadMigrations', () => {
  it('returns every migration in version order', () => {
    const migrations = loadMigrations();

    expect(migrations.length).toBeGreaterThan(0);

    const versions = migrations.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort());
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('parses the version and name out of each filename', () => {
    const migrations = loadMigrations();

    for (const migration of migrations) {
      expect(migration.version).toMatch(/^\d{14}$/);
      expect(migration.name).not.toHaveLength(0);
      expect(migration.sql.trim()).not.toHaveLength(0);
    }
  });

  it('rejects a directory that does not exist', () => {
    expect(() => loadMigrations('/nonexistent/migrations')).toThrow(/not found/);
  });
});

describe.skipIf(!hasDatabase)('migrate (bare PostgreSQL)', () => {
  let database: TempDatabase;

  beforeAll(async () => {
    database = await createTempDatabase('migrate');
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('applies every migration to an empty database', async () => {
    const result = await migrate({ client: database.client, mode: 'bare' });

    expect(result.applied).toEqual(loadMigrations().map((migration) => migration.version));
    expect(result.alreadyApplied).toHaveLength(0);
  }, 60_000);

  it('records migrations in the ledger the Supabase CLI reads', async () => {
    // Schema, table, and column names have to match exactly, or `supabase db
    // push` will not see what this runner applied and will try to re-apply it.
    const ledgerExists = await scalar<boolean>(
      database.client,
      `select exists (
         select 1 from information_schema.tables
          where table_schema = 'supabase_migrations' and table_name = 'schema_migrations')`,
    );
    expect(ledgerExists).toBe(true);

    const { rows } = await database.client.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type
         from information_schema.columns
        where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'
        order by column_name`,
    );

    expect(rows.map((row) => row.column_name)).toEqual(['name', 'statements', 'version']);
    expect(rows.find((row) => row.column_name === 'statements')?.data_type).toBe('ARRAY');

    const recorded = await scalar<string>(
      database.client,
      'select count(*)::text from supabase_migrations.schema_migrations',
    );
    expect(Number(recorded)).toBe(loadMigrations().length);
  });

  it('is idempotent on a second run', async () => {
    const result = await migrate({ client: database.client, mode: 'bare' });

    expect(result.applied).toHaveLength(0);
    expect(result.alreadyApplied).toHaveLength(loadMigrations().length);
  }, 60_000);

  it('creates the Supabase surface the migrations depend on', async () => {
    const authUidExists = await scalar<boolean>(
      database.client,
      `select exists (
         select 1 from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'auth' and p.proname = 'uid')`,
    );
    expect(authUidExists).toBe(true);

    const { rows } = await database.client.query<{ rolname: string }>(
      `select rolname from pg_roles
        where rolname in ('anon', 'authenticated', 'service_role') order by rolname`,
    );
    expect(rows.map((row) => row.rolname)).toEqual(['anon', 'authenticated', 'service_role']);
  });

  it('provisions xp_ledger partitions ahead of and behind the current month', async () => {
    const partitions = await scalar<string>(
      database.client,
      `select count(*)::text
         from pg_inherits i
         join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'public.xp_ledger'::regclass`,
    );

    // Six months back, three ahead, the current month, and the default.
    expect(Number(partitions)).toBe(11);
  });
});

describe.skipIf(!hasDatabase)('the compat shim is load-bearing', () => {
  let database: TempDatabase;

  beforeAll(async () => {
    database = await createTempDatabase('noshim');
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('fails on a bare server when the shim is skipped', async () => {
    // Guards against the shim quietly becoming unnecessary -- if this ever
    // passes, the migrations have stopped depending on the Supabase surface and
    // the bare/supabase distinction can be dropped.
    await expect(migrate({ client: database.client, mode: 'supabase' })).rejects.toThrow(
      /Migration .* failed/,
    );
  }, 60_000);
});

describe.skipIf(!hasDatabase)('migration failures', () => {
  let database: TempDatabase;

  beforeAll(async () => {
    database = await createTempDatabase('rollback');
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('rolls a failed migration back rather than leaving it half applied', async () => {
    const client: Client = database.client;

    await expect(
      migrate({
        client,
        mode: 'bare',
        migrationsDir: `${__dirname}/fixtures/broken`,
      }),
    ).rejects.toThrow(/20990101000000_broken\.sql failed/);

    // The first statement of the broken migration created a table; the failure
    // must have taken it with it.
    const survived = await scalar<boolean>(
      client,
      `select exists (select 1 from information_schema.tables where table_name = 'should_not_survive')`,
    );
    expect(survived).toBe(false);

    const recorded = await scalar<string>(
      client,
      `select count(*)::text from supabase_migrations.schema_migrations where version = '20990101000000'`,
    );
    expect(Number(recorded)).toBe(0);
  }, 60_000);
});
