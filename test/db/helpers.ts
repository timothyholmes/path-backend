import { Client } from 'pg';
import { migrate } from '../../db/migrate';
import { resetAuthUserColumnCache } from '../../db/seed/authUsers';

/**
 * Database tests need a real PostgreSQL server. When DATABASE_URL is unset they
 * are skipped rather than failed, so `npm test` still works for someone who has
 * only checked the repo out. CI always sets it.
 */
export const DATABASE_URL = process.env.DATABASE_URL;
export const hasDatabase = Boolean(DATABASE_URL);

function adminUrl(): string {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
  return DATABASE_URL;
}

function urlForDatabase(name: string): string {
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

export interface TempDatabase {
  name: string;
  url: string;
  client: Client;
  drop(): Promise<void>;
}

/**
 * Creates a throwaway database and connects to it.
 *
 * Each test file gets its own database rather than sharing one and cleaning up
 * between tests: vitest runs files in separate processes, and a shared database
 * would make them order-dependent.
 */
export async function createTempDatabase(label: string): Promise<TempDatabase> {
  const name = `path_test_${label}_${process.pid}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');

  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    // CREATE DATABASE cannot run inside a transaction block.
    await admin.query(`drop database if exists "${name}"`);
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }

  const url = urlForDatabase(name);
  const client = new Client({ connectionString: url });
  await client.connect();

  // auth.users column detection is memoised per process; a fresh database
  // invalidates it.
  resetAuthUserColumnCache();

  return {
    name,
    url,
    client,
    async drop() {
      await client.end();
      const cleanup = new Client({ connectionString: adminUrl() });
      await cleanup.connect();
      try {
        await cleanup.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/** A temp database with every migration applied through the bare-Postgres path. */
export async function createMigratedDatabase(label: string): Promise<TempDatabase> {
  const database = await createTempDatabase(label);
  await migrate({ client: database.client, mode: 'bare' });
  return database;
}

export async function count(client: Client, table: string): Promise<number> {
  const { rows } = await client.query<{ count: string }>(`select count(*) from ${table}`);
  return Number(rows[0].count);
}

export async function scalar<T>(client: Client, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await client.query(sql, params);
  return Object.values(rows[0])[0] as T;
}
