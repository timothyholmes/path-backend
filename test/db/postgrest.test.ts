import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * RLS over the wire.
 *
 * supabase/tests/01_rls_isolation.sql already proves the policies, but it does
 * it with `set local role authenticated` and a hand-written
 * `request.jwt.claims`. That skips the layer the design actually bets on: the
 * mobile client holds an anon key and a user JWT and talks to PostgREST, so
 * between the policy and the client sit schema exposure, the JWT-to-role
 * mapping, table and column grants, and resource embedding. A policy can be
 * perfect while any one of those hands a row to the wrong user — auto-exposure
 * of a new table being the classic way it happens.
 *
 * These tests therefore assert from the outside, over HTTP, with no privileged
 * connection: exactly what an attacker holding a published anon key can reach.
 *
 * They need a running Supabase stack (`npm run db:start`) and are skipped
 * otherwise, matching the DATABASE_URL convention in helpers.ts.
 */
const API_URL = process.env.SUPABASE_API_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hasSupabaseApi = Boolean(API_URL && ANON_KEY && SERVICE_ROLE_KEY);

interface TestUser {
  id: string;
  email: string;
  token: string;
}

/** Signs up a throwaway user. The email is unique per run so repeated runs
 *  against a long-lived local stack do not collide. */
async function createUser(label: string): Promise<TestUser> {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@postgrest.test`;
  const response = await fetch(`${API_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'postgrest-test-password',
      data: { display_name: label, timezone: 'UTC' },
    }),
  });

  const body = (await response.json()) as { access_token?: string; user?: { id: string } };
  if (!response.ok || !body.access_token || !body.user) {
    throw new Error(`signup failed for ${label}: ${JSON.stringify(body)}`);
  }

  return { id: body.user.id, email, token: body.access_token };
}

async function deleteUser(id: string): Promise<void> {
  await fetch(`${API_URL}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: {
      apikey: SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
}

interface RestResult<T = unknown> {
  status: number;
  body: T;
}

/** A PostgREST call carrying the anon key, and a user JWT when one is given —
 *  the exact header pair supabase-js sends from the client. */
async function rest<T = unknown>(
  path: string,
  options: { token?: string; method?: string; body?: unknown } = {},
): Promise<RestResult<T>> {
  const headers: Record<string, string> = {
    apikey: ANON_KEY!,
    'Content-Type': 'application/json',
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const response = await fetch(`${API_URL}/rest/v1/${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: (text === '' ? null : JSON.parse(text)) as T,
  };
}

describe.skipIf(!hasSupabaseApi)('RLS through PostgREST', () => {
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);

    // Each user gets one private row of each shape the client will read.
    for (const user of [alice, bob]) {
      const routine = await rest('routines', {
        token: user.token,
        method: 'POST',
        body: { user_id: user.id, title: `${user.id} routine`, frequency: 'daily' },
      });
      expect(routine.status).toBe(201);

      const log = await rest('field_logs', {
        token: user.token,
        method: 'POST',
        body: { user_id: user.id, content: { text: `${user.id} private thoughts` } },
      });
      expect(log.status).toBe(201);
    }
  }, 60_000);

  afterAll(async () => {
    // The auth.users cascade takes every row created above with it.
    await Promise.all([alice && deleteUser(alice.id), bob && deleteUser(bob.id)]);
  });

  describe('the published anon key on its own', () => {
    it('cannot read user data', async () => {
      const { status, body } = await rest<{ code: string }>('virtues?select=name');

      expect(status).toBe(401);
      expect(body.code).toBe('42501');
    });

    it('cannot read profiles', async () => {
      const { status } = await rest('profiles?select=display_name');

      expect(status).toBe(401);
    });

    it('still reaches deliberately public reference data', async () => {
      const { status, body } = await rest<unknown[]>('level_thresholds?select=level&limit=3');

      expect(status).toBe(200);
      expect(body).toHaveLength(3);
    });
  });

  describe('a signed-in user', () => {
    it('sees their own profile and nobody else’s', async () => {
      const { status, body } = await rest<{ id: string }[]>('profiles?select=id', {
        token: alice.token,
      });

      expect(status).toBe(200);
      expect(body).toEqual([{ id: alice.id }]);
    }, 15_000);

    it('gets the four starter virtues the signup trigger created', async () => {
      const { body } = await rest<{ name: string }[]>('virtues?select=name&order=display_order', {
        token: alice.token,
      });

      expect(body.map((virtue) => virtue.name)).toEqual(['Body', 'Mind', 'Craft', 'Spirit']);
    });

    it('sees only their own routines and field logs', async () => {
      const routines = await rest<{ title: string }[]>('routines?select=title', {
        token: alice.token,
      });
      const logs = await rest<unknown[]>('field_logs?select=content', { token: alice.token });

      expect(routines.body).toEqual([{ title: `${alice.id} routine` }]);
      expect(logs.body).toHaveLength(1);
    });

    it('gets nothing back when filtering explicitly for another user’s rows', async () => {
      const profile = await rest<unknown[]>(`profiles?id=eq.${bob.id}&select=display_name`, {
        token: alice.token,
      });
      const logs = await rest<unknown[]>(`field_logs?user_id=eq.${bob.id}&select=content`, {
        token: alice.token,
      });

      expect(profile.body).toEqual([]);
      expect(logs.body).toEqual([]);
    });

    // Embedding is PostgREST-only syntax: it rewrites the request into a join
    // the pgTAP suite never issues, so it needs its own assertion that the
    // embedded side is filtered by its own policy too.
    it('cannot reach another user’s rows through an embedded resource', async () => {
      const { status, body } = await rest<{ display_name: string; virtues: unknown[] }[]>(
        'profiles?select=display_name,virtues(name)',
        { token: alice.token },
      );

      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0].virtues).toHaveLength(4);
    });

    it('cannot insert a row owned by somebody else', async () => {
      const { status, body } = await rest<{ message: string }>('routines', {
        token: alice.token,
        method: 'POST',
        body: { user_id: bob.id, title: 'planted', frequency: 'daily' },
      });

      expect(status).toBe(403);
      expect(body.message).toMatch(/row-level security/i);
    });

    it('cannot update another user’s rows', async () => {
      await rest(`routines?user_id=eq.${bob.id}`, {
        token: alice.token,
        method: 'PATCH',
        body: { title: 'HIJACKED' },
      });

      const { body } = await rest<{ title: string }[]>('routines?select=title', {
        token: bob.token,
      });
      expect(body).toEqual([{ title: `${bob.id} routine` }]);
    });

    it('cannot delete another user’s rows', async () => {
      await rest(`field_logs?user_id=eq.${bob.id}`, { token: alice.token, method: 'DELETE' });

      const { body } = await rest<unknown[]>('field_logs?select=id', { token: bob.token });
      expect(body).toHaveLength(1);
    });
  });

  describe('column grants', () => {
    it('refuse a self-granted subscription upgrade', async () => {
      const { status, body } = await rest<{ code: string }>(`profiles?id=eq.${alice.id}`, {
        token: alice.token,
        method: 'PATCH',
        body: { subscription_tier: 'premium' },
      });

      expect(status).toBe(403);
      expect(body.code).toBe('42501');
    });

    it('refuse a self-granted XP balance', async () => {
      const { status } = await rest(`profiles?id=eq.${alice.id}`, {
        token: alice.token,
        method: 'PATCH',
        body: { global_xp: 999_999 },
      });

      expect(status).toBe(403);
    });

    it('still allow the two columns a user owns', async () => {
      const { status } = await rest(`profiles?id=eq.${alice.id}`, {
        token: alice.token,
        method: 'PATCH',
        body: { display_name: 'Alice', timezone: 'Europe/Berlin' },
      });

      expect(status).toBe(204);
    });
  });

  describe('the xp_ledger', () => {
    it('is append-only to clients', async () => {
      const { status, body } = await rest<{ code: string }>('xp_ledger', {
        token: alice.token,
        method: 'POST',
        body: {
          user_id: alice.id,
          source_type: 'bonus',
          base_xp: 999_999,
          final_xp: 999_999,
        },
      });

      expect(status).toBe(403);
      expect(body.code).toBe('42501');
    });

    // The partitions live in `private` precisely so PostgREST cannot see them;
    // reaching one directly would sidestep the parent table's policy.
    it('exposes no partition through the Data API', async () => {
      const month = new Date().toISOString().slice(0, 7).replace('-', '_');
      const { status } = await rest(`xp_ledger_${month}?select=id`, { token: alice.token });

      expect(status).toBe(404);
    });
  });

  describe('SECURITY DEFINER RPC', () => {
    it('awards XP to the caller', async () => {
      const { status, body } = await rest<{ xp_earned: number }>('rpc/calculate_and_award_xp', {
        token: alice.token,
        method: 'POST',
        body: {
          p_user_id: alice.id,
          p_source_type: 'bonus',
          p_source_id: null,
          p_base_xp: 10,
        },
      });

      expect(status).toBe(200);
      expect(body.xp_earned).toBe(10);
    });

    // The function bypasses RLS by design, so this assertion is the only thing
    // standing between a signed-in user and another user's XP.
    it('refuses to award XP to anybody else', async () => {
      const { status, body } = await rest<{ message: string }>('rpc/calculate_and_award_xp', {
        token: alice.token,
        method: 'POST',
        body: {
          p_user_id: bob.id,
          p_source_type: 'bonus',
          p_source_id: null,
          p_base_xp: 999_999,
        },
      });

      expect(status).toBe(403);
      expect(body.message).toMatch(/another user/i);
    });

    it('refuses to recalculate anybody else’s streak', async () => {
      const { status } = await rest('rpc/recalculate_streak', {
        token: alice.token,
        method: 'POST',
        body: { p_user_id: bob.id },
      });

      expect(status).toBe(403);
    });

    it('keeps the ledger it wrote visible only to its owner', async () => {
      const mine = await rest<unknown[]>('xp_ledger?select=id', { token: alice.token });
      const theirs = await rest<unknown[]>('xp_ledger?select=id', { token: bob.token });

      expect(mine.body).toHaveLength(1);
      expect(theirs.body).toHaveLength(0);
    });
  });
});
