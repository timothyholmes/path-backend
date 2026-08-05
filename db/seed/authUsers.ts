import { Client } from 'pg';

/**
 * Password given to every seeded user in local development. Seed data is not a
 * security boundary; this exists so a developer can actually sign in as a
 * seeded account from the app. It is only set when pgcrypto is available.
 */
export const SEED_PASSWORD = 'path-dev-password';

export interface AuthUserSpec {
  id: string;
  email: string;
  displayName?: string;
  timezone?: string;
  createdAt?: Date;
}

/**
 * Columns worth setting when they exist, with the value to use.
 *
 * The two auth.users tables this has to satisfy are very different: the compat
 * shim's has four columns, real Supabase Auth's has roughly thirty and gains
 * more over time. Rather than maintaining two code paths (or a hardcoded column
 * list that breaks on the next GoTrue release), the insert is built from
 * whichever of these columns the target database actually has.
 *
 * The empty-string token columns are deliberate: GoTrue fails to scan NULLs out
 * of them, so a user seeded with NULL tokens cannot sign in.
 */
function candidateColumns(spec: AuthUserSpec): Record<string, unknown> {
  const createdAt = spec.createdAt ?? new Date();

  return {
    id: spec.id,
    instance_id: '00000000-0000-0000-0000-000000000000',
    aud: 'authenticated',
    role: 'authenticated',
    email: spec.email,
    email_confirmed_at: createdAt,
    raw_app_meta_data: JSON.stringify({ provider: 'email', providers: ['email'] }),
    raw_user_meta_data: JSON.stringify({
      display_name: spec.displayName ?? spec.email.split('@')[0],
      timezone: spec.timezone ?? 'UTC',
    }),
    is_sso_user: false,
    is_anonymous: false,
    created_at: createdAt,
    updated_at: createdAt,
    confirmation_token: '',
    recovery_token: '',
    email_change_token_new: '',
    email_change_token_current: '',
    email_change: '',
  };
}

let columnCache: Set<string> | null = null;

async function authUserColumns(client: Client): Promise<Set<string>> {
  if (columnCache) return columnCache;

  const { rows } = await client.query<{ column_name: string }>(
    `select column_name
       from information_schema.columns
      where table_schema = 'auth' and table_name = 'users'`,
  );

  if (rows.length === 0) {
    throw new Error('auth.users does not exist. Run migrations first.');
  }

  columnCache = new Set(rows.map((row) => row.column_name));
  return columnCache;
}

/** Exported for tests, which reuse one connection across differing databases. */
export function resetAuthUserColumnCache(): void {
  columnCache = null;
}

async function hasPgcrypto(client: Client): Promise<boolean> {
  const { rows } = await client.query(`select 1 from pg_extension where extname = 'pgcrypto'`);
  return rows.length > 0;
}

/**
 * Inserts an auth user. The signup trigger installed by the profiles migration
 * creates the matching profile row and starter virtues, so seeding goes through
 * the same path a real signup does.
 */
export async function createAuthUser(client: Client, spec: AuthUserSpec): Promise<string> {
  const available = await authUserColumns(client);
  const candidates = candidateColumns(spec);

  const columns = Object.keys(candidates).filter((column) => available.has(column));
  const values = columns.map((column) => candidates[column]);
  const placeholders = columns.map((_, index) => `$${index + 1}`);

  await client.query(
    `insert into auth.users (${columns.map((c) => `"${c}"`).join(', ')})
     values (${placeholders.join(', ')})
     on conflict (id) do nothing`,
    values,
  );

  if (available.has('encrypted_password') && (await hasPgcrypto(client))) {
    await client.query(
      `update auth.users
          set encrypted_password = crypt($1, gen_salt('bf'))
        where id = $2 and coalesce(encrypted_password, '') = ''`,
      [SEED_PASSWORD, spec.id],
    );
  }

  return spec.id;
}
