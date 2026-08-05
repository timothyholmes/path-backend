import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCENARIOS, seed } from '../../db/seed';
import { seedId } from '../../db/seed/rng';
import { TempDatabase, createMigratedDatabase, hasDatabase, scalar } from './helpers';

const AS_OF = new Date('2026-08-04T12:00:00.000Z');

describe('scenario registry', () => {
  it('exposes every scenario under its declared name', () => {
    for (const [key, scenario] of Object.entries(SCENARIOS)) {
      expect(scenario.name).toBe(key);
      expect(scenario.description).not.toHaveLength(0);
    }
  });

  it('covers the documented scenarios', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([
      'active-free',
      'edge-cases',
      'empty',
      'new-user',
      'premium-power-user',
    ]);
  });
});

describe.skipIf(!hasDatabase)('seeding', () => {
  let database: TempDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('seed');
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('rejects an unknown scenario by name', async () => {
    await expect(
      seed({ client: database.client, scenario: 'does-not-exist', asOf: AS_OF }),
    ).rejects.toThrow(/Unknown scenario/);
  });

  it('leaves a migrated database untouched for the empty scenario', async () => {
    const summary = await seed({ client: database.client, scenario: 'empty', asOf: AS_OF });

    expect(summary.users).toHaveLength(0);
    expect(summary.counts.profiles).toBe(0);
    expect(summary.counts.xp_ledger).toBe(0);
  });

  it('creates a profile and starter virtues through the signup trigger', async () => {
    const summary = await seed({ client: database.client, scenario: 'new-user', asOf: AS_OF });

    expect(summary.users).toHaveLength(1);
    expect(summary.counts.profiles).toBe(1);
    // Four is both the starter set and the free-tier cap.
    expect(summary.counts.virtues).toBe(4);
    expect(summary.counts.xp_ledger).toBe(0);

    const level = await scalar<number>(
      database.client,
      'select global_level from public.profiles where id = $1',
      [summary.users[0].id],
    );
    expect(level).toBe(1);
  }, 60_000);
});

describe.skipIf(!hasDatabase)('active-free scenario', () => {
  let database: TempDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('activefree');
    await seed({ client: database.client, scenario: 'active-free', asOf: AS_OF });
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('sits exactly on every free-tier cap', async () => {
    const virtues = await scalar<string>(
      database.client,
      'select count(*)::text from public.virtues',
    );
    const activeRoutines = await scalar<string>(
      database.client,
      'select count(*)::text from public.routines where is_active',
    );
    const activeGoals = await scalar<string>(
      database.client,
      `select count(*)::text from public.goals where status = 'active'`,
    );

    expect(Number(virtues)).toBe(4);
    expect(Number(activeRoutines)).toBe(10);
    expect(Number(activeGoals)).toBe(3);
  });

  it('cannot take one more of anything', async () => {
    const userId = await scalar<string>(database.client, 'select id from public.profiles limit 1');

    await expect(
      database.client.query(`insert into public.virtues (user_id, name) values ($1, 'Fifth')`, [
        userId,
      ]),
    ).rejects.toThrow(/free plan allows at most 4/);

    await expect(
      database.client.query(
        `insert into public.routines (user_id, title, frequency) values ($1, 'Eleventh', 'daily')`,
        [userId],
      ),
    ).rejects.toThrow(/free plan allows at most 10/);
  });

  it('produces basic text field logs with no AI analysis', async () => {
    const analysed = await scalar<string>(
      database.client,
      'select count(*)::text from public.field_logs where ai_analysis is not null',
    );
    const templated = await scalar<string>(
      database.client,
      'select count(*)::text from public.field_logs where template_id is not null',
    );

    expect(Number(analysed)).toBe(0);
    expect(Number(templated)).toBe(0);
  });
});

describe.skipIf(!hasDatabase)('premium-power-user scenario', () => {
  let database: TempDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('premium');
    await seed({ client: database.client, scenario: 'premium-power-user', asOf: AS_OF });
  }, 300_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('holds the XP invariant across virtue and global-only awards', async () => {
    // global_xp accounts for every ledger row; virtue XP accounts only for rows
    // attributed to a virtue. The difference is exactly the global-only total.
    const balanced = await scalar<boolean>(
      database.client,
      `select (select global_xp from public.profiles)
              = (select sum(xp) from public.virtues)
                + (select coalesce(sum(final_xp), 0) from public.xp_ledger where virtue_id is null)`,
    );

    expect(balanced).toBe(true);
  });

  it('matches daily_activity to the ledger', async () => {
    const matches = await scalar<boolean>(
      database.client,
      `select (select sum(xp_earned) from public.daily_activity)
              = (select sum(final_xp) from public.xp_ledger)`,
    );

    expect(matches).toBe(true);
  });

  it('reaches the streak multiplier cap', async () => {
    const { rows } = await database.client.query<{
      current_streak: number;
      streak_multiplier: string;
    }>('select current_streak, streak_multiplier from public.profiles');

    expect(rows[0].current_streak).toBeGreaterThanOrEqual(20);
    expect(Number(rows[0].streak_multiplier)).toBe(2);
  });

  it('spreads ledger rows across several monthly partitions', async () => {
    const partitions = await scalar<string>(
      database.client,
      'select count(distinct tableoid)::text from public.xp_ledger',
    );

    // 90 days of history has to cross at least three month boundaries.
    expect(Number(partitions)).toBeGreaterThanOrEqual(3);
  });

  it('never routes a row into the default partition', async () => {
    // Rows in the default partition would block ATTACH for that month later.
    const stranded = await scalar<string>(
      database.client,
      `select count(*)::text from private.xp_ledger_default`,
    );

    expect(Number(stranded)).toBe(0);
  });

  it('exercises the premium-only features', async () => {
    const templated = await scalar<string>(
      database.client,
      'select count(*)::text from public.field_logs where template_id is not null and ai_analysis is not null',
    );
    const skipped = await scalar<string>(
      database.client,
      `select count(*)::text from public.session_instances where status = 'skipped'`,
    );
    const partial = await scalar<string>(
      database.client,
      `select count(*)::text from public.session_instances
        where status = 'completed'
          and actual_duration_seconds < (select target_duration_minutes * 60
                                           from public.sessions s
                                          where s.id = session_instances.session_id)`,
    );

    expect(Number(templated)).toBeGreaterThan(0);
    expect(Number(skipped)).toBeGreaterThan(0);
    expect(Number(partial)).toBeGreaterThan(0);
  });

  it('writes both retrospective cadences with chat history', async () => {
    // Ordered by text, not by the enum, which sorts in declaration order.
    const { rows } = await database.client.query<{ period_type: string; count: string }>(
      `select period_type, count(*) from public.retrospectives
        group by period_type order by period_type::text`,
    );

    expect(rows.map((row) => row.period_type)).toEqual(['monthly', 'weekly']);

    const withChat = await scalar<string>(
      database.client,
      'select count(*)::text from public.retrospectives where jsonb_array_length(chat_history) > 0',
    );
    expect(Number(withChat)).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasDatabase)('edge-cases scenario', () => {
  let database: TempDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('edgecases');
    await seed({ client: database.client, scenario: 'edge-cases', asOf: AS_OF });
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('reports a broken streak as zero while keeping the historical best', async () => {
    const { rows } = await database.client.query<{
      current_streak: number;
      longest_streak: number;
    }>(
      `select current_streak, longest_streak from public.profiles where email = 'broken@path.test'`,
    );

    expect(rows[0].current_streak).toBe(0);
    expect(rows[0].longest_streak).toBeGreaterThan(0);
  });

  it('allows XP to go negative without breaking the level function', async () => {
    const lowestXp = await scalar<number>(database.client, 'select min(xp) from public.virtues');
    const lowestLevel = await scalar<number>(
      database.client,
      'select min(level) from public.virtues',
    );

    expect(lowestXp).toBeLessThan(0);
    expect(lowestLevel).toBe(1);
  });

  it('records global-only XP with a null virtue', async () => {
    const globalOnly = await scalar<string>(
      database.client,
      'select count(*)::text from public.xp_ledger where virtue_id is null',
    );

    expect(Number(globalOnly)).toBeGreaterThan(0);
  });

  it('keeps rows created while premium after the subscription lapses', async () => {
    const userId = await scalar<string>(
      database.client,
      `select id from public.profiles where email = 'lapsed@path.test'`,
    );

    const routines = await scalar<string>(
      database.client,
      'select count(*)::text from public.routines where user_id = $1',
      [userId],
    );
    expect(Number(routines)).toBe(12);

    // But the free cap now applies to anything new.
    await expect(
      database.client.query(
        `insert into public.routines (user_id, title, frequency) values ($1, 'After lapse', 'daily')`,
        [userId],
      ),
    ).rejects.toThrow(/free plan allows at most 10/);
  });

  it('nests goals four levels deep', async () => {
    const depth = await scalar<number>(
      database.client,
      `with recursive chain as (
         select id, 1 as depth from public.goals where parent_goal_id is null
         union all
         select g.id, c.depth + 1 from public.goals g join chain c on g.parent_goal_id = c.id
       ) select max(depth) from chain`,
    );

    expect(depth).toBe(4);
  });
});

describe.skipIf(!hasDatabase)('determinism', () => {
  let first: TempDatabase;
  let second: TempDatabase;

  beforeAll(async () => {
    first = await createMigratedDatabase('determinism_a');
    second = await createMigratedDatabase('determinism_b');
  }, 180_000);

  afterAll(async () => {
    await first?.drop();
    await second?.drop();
  });

  it('produces identical ids across separate runs and databases', async () => {
    const a = await seed({ client: first.client, scenario: 'active-free', asOf: AS_OF });
    const b = await seed({ client: second.client, scenario: 'active-free', asOf: AS_OF });

    expect(a.users.map((user) => user.id)).toEqual(b.users.map((user) => user.id));
    expect(a.counts).toEqual(b.counts);

    // Ids are derived, not random, so a test can hard-code them.
    expect(a.users[0].id).toBe(seedId('user:active-free'));
  }, 240_000);

  it('refuses to re-seed a scenario and rolls the attempt back', async () => {
    const beforeProfiles = await scalar<string>(
      first.client,
      'select count(*)::text from public.profiles',
    );
    const beforeLedger = await scalar<string>(
      first.client,
      'select count(*)::text from public.xp_ledger',
    );

    // Without the guard this would succeed and silently append a second copy of
    // the user's XP history, since ledger rows are append-only.
    await expect(
      seed({ client: first.client, scenario: 'active-free', asOf: AS_OF }),
    ).rejects.toThrow(/already exists/);

    expect(await scalar<string>(first.client, 'select count(*)::text from public.profiles')).toBe(
      beforeProfiles,
    );
    expect(await scalar<string>(first.client, 'select count(*)::text from public.xp_ledger')).toBe(
      beforeLedger,
    );
  }, 240_000);

  it('allows a different scenario to be layered into the same database', async () => {
    const before = Number(
      await scalar<string>(first.client, 'select count(*)::text from public.profiles'),
    );

    const summary = await seed({ client: first.client, scenario: 'new-user', asOf: AS_OF });

    expect(summary.counts.profiles).toBe(before + 1);
  }, 240_000);
});
