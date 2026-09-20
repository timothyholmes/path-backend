import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StatusCodes } from 'http-status-codes';
import { TempDatabase, createMigratedDatabase, hasDatabase } from '../../db/helpers';
import { seedUser, SeedUserOptions, SeededUser } from '../shared/fixtures';
import { createDbTestApp, DbTestApp } from '../shared/testApp';

interface VirtueRow {
  id: string;
  name: string;
  xp: number;
  level: number;
  display_order: number;
}

interface LedgerRow {
  virtue_id: string | null;
  final_xp: number;
  description: string | null;
}

/** `YYYY-MM-DD` for an instant as the given zone sees it — how the API buckets a day. */
function localDate(at: Date, timeZone: string): string {
  return at.toLocaleDateString('en-CA', { timeZone });
}

/** `daysAgo` days back from now, at 02:00 UTC — early enough that zones west of UTC are still on the previous day. */
function earlyUtcMorning(daysAgo: number): Date {
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  at.setUTCHours(2, 0, 0, 0);
  return at;
}

describe.skipIf(!hasDatabase)('virtues', () => {
  let database: TempDatabase;
  let user: SeededUser;
  let app: DbTestApp;

  beforeAll(async () => {
    database = await createMigratedDatabase('virtues');
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  // Every test gets its own freshly seeded user, and therefore its own four
  // starter virtues and untouched XP totals, so tests never depend on ordering
  // or on what an earlier test left behind.
  beforeEach(async () => {
    user = await seedUser(database.client);
    app = createDbTestApp(database.url, user.id);
  });

  afterEach(async () => {
    await app.dependencies.pool.end();
  });

  async function withUser<T>(
    options: SeedUserOptions,
    fn: (otherApp: DbTestApp, otherUser: SeededUser) => Promise<T>,
  ): Promise<T> {
    const otherUser = await seedUser(database.client, options);
    const otherApp = createDbTestApp(database.url, otherUser.id);
    try {
      return await fn(otherApp, otherUser);
    } finally {
      await otherApp.dependencies.pool.end();
    }
  }

  async function virtueRows(userId = user.id): Promise<VirtueRow[]> {
    const { rows } = await database.client.query<VirtueRow>(
      `select id, name, xp, level, display_order from public.virtues
        where user_id = $1 order by display_order, created_at`,
      [userId],
    );
    return rows;
  }

  async function ledger(userId = user.id): Promise<LedgerRow[]> {
    const { rows } = await database.client.query<LedgerRow>(
      `select virtue_id, final_xp, description from public.xp_ledger
        where user_id = $1 order by created_at`,
      [userId],
    );
    return rows;
  }

  async function globalXp(userId = user.id): Promise<number> {
    const { rows } = await database.client.query<{ global_xp: number }>(
      `select global_xp from public.profiles where id = $1`,
      [userId],
    );
    return rows[0].global_xp;
  }

  /**
   * Writes a ledger row directly, at a chosen instant, so history windows are
   * deterministic. Backdating needs the partitions to exist for that month;
   * anything outside the provisioned range lands in the default partition, which
   * is fine for a throwaway test database but is why the range is topped up here.
   */
  async function recordXp(virtueId: string, xp: number, at: Date, userId = user.id) {
    await database.client.query(`select private.ensure_xp_ledger_partitions(3, 12)`);
    await database.client.query(
      `insert into public.xp_ledger (user_id, virtue_id, source_type, source_id,
                                    base_xp, final_xp, description, created_at)
       values ($1, $2, 'bonus', null, $3, $3, 'Test award', $4)`,
      [userId, virtueId, xp, at.toISOString()],
    );
  }

  /** The real scoring path, so `profiles.global_xp` and `virtues.xp` move the way production moves them. */
  async function awardXp(virtueId: string, baseXp: number, userId = user.id) {
    await database.client.query(
      `select public.calculate_and_award_xp($1, 'goal', null, $2, array[$3::uuid], 'Goal completed: Test')`,
      [userId, baseXp, virtueId],
    );
  }

  /** Frees a slot under the four-virtue free cap, which signup fills exactly. */
  async function deleteStarterVirtue(index = 3) {
    const res = await app.agent.delete(`/virtues/${user.virtueIds[index]}`);
    expect(res.status).toBe(StatusCodes.NO_CONTENT);
  }

  /** Creates a virtue through the API and returns its body, failing loudly if the create didn't. */
  async function createVirtue(body: Record<string, unknown> = {}, agent = app.agent) {
    const res = await agent.post('/virtues').send({ name: 'Service', ...body });
    expect(res.status).toBe(StatusCodes.CREATED);
    return res.body;
  }

  describe('GET /virtues', () => {
    it('returns the four starter virtues in display order', async () => {
      const res = await app.agent.get('/virtues');

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body.map((virtue: { name: string }) => virtue.name)).toEqual([
        'Body',
        'Mind',
        'Craft',
        'Spirit',
      ]);
    });

    it('returns each virtue with its presentation and derived XP', async () => {
      const res = await app.agent.get('/virtues');

      expect(res.body[0]).toEqual({
        id: user.virtueIds[0],
        user_id: user.id,
        name: 'Body',
        icon: 'figure.run',
        color: '#E5533D',
        xp: 0,
        level: 1,
        display_order: 0,
      });
    });

    it('reflects XP awarded by the scoring function', async () => {
      await awardXp(user.virtueIds[0], 120);

      const res = await app.agent.get('/virtues');

      expect(res.body[0]).toMatchObject({ xp: 120, level: 2 });
    });

    // A new virtue lands at its display_order rather than at the end, and
    // creation time only breaks a tie — here against Mind, which shares order 1.
    it('orders a new virtue by its display_order, not its creation time', async () => {
      await deleteStarterVirtue();
      await createVirtue({ name: 'Service', display_order: 1 });

      const res = await app.agent.get('/virtues');

      expect(res.body.map((virtue: { name: string }) => virtue.name)).toEqual([
        'Body',
        'Mind',
        'Service',
        'Craft',
      ]);
    });

    it("never returns another user's virtues", async () =>
      withUser({}, async (otherApp, otherUser) => {
        await otherApp.agent.get('/virtues');

        const res = await app.agent.get('/virtues');

        expect(res.body.map((virtue: { id: string }) => virtue.id)).toEqual(user.virtueIds);
        expect(res.body.map((virtue: { id: string }) => virtue.id)).not.toContain(
          otherUser.virtueIds[0],
        );
      }));

    it('requires authentication', async () => {
      const res = await app.unauthenticatedAgent.get('/virtues');

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('POST /virtues', () => {
    it('creates a virtue with the schema defaults', async () => {
      await deleteStarterVirtue();

      const res = await app.agent.post('/virtues').send({ name: 'Service' });

      expect(res.status).toBe(StatusCodes.CREATED);
      expect(res.body).toMatchObject({
        user_id: user.id,
        name: 'Service',
        icon: null,
        color: null,
        xp: 0,
        level: 1,
        display_order: 0,
      });
      expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('stores every supplied field', async () => {
      await deleteStarterVirtue();

      const virtue = await createVirtue({
        name: 'Service',
        icon: 'hands.sparkles',
        color: '#2FA84F',
        display_order: 7,
      });

      expect(virtue).toMatchObject({
        name: 'Service',
        icon: 'hands.sparkles',
        color: '#2FA84F',
        display_order: 7,
      });
    });

    // Signup seeds exactly four virtues, which is also the free-tier cap, so a
    // free user's first create is already the one over the line.
    it('returns 402 for a fifth virtue on the free plan', async () => {
      const res = await app.agent.post('/virtues').send({ name: 'Service' });

      expect(res.status).toBe(StatusCodes.PAYMENT_REQUIRED);
      expect(res.body.message).toMatch(/at most 4 virtues/);
      expect(await virtueRows()).toHaveLength(4);
    });

    it('lets a premium user past the cap', async () =>
      withUser({ tier: 'premium' }, async (premiumApp) => {
        const res = await premiumApp.agent.post('/virtues').send({ name: 'Service' });

        expect(res.status).toBe(StatusCodes.CREATED);
      }));

    it('caps a lapsed premium user like a free one', async () =>
      withUser(
        { tier: 'premium', subscriptionExpiresAt: new Date(Date.now() - 86_400_000) },
        async (lapsedApp) => {
          const res = await lapsedApp.agent.post('/virtues').send({ name: 'Service' });

          expect(res.status).toBe(StatusCodes.PAYMENT_REQUIRED);
        },
      ));

    it('returns 409 for a name the user already has', async () => {
      const res = await app.agent.post('/virtues').send({ name: 'Body' });

      expect(res.status).toBe(StatusCodes.CONFLICT);
      expect(res.body.message).toMatch(/already exists/);
    });

    // Names are unique per user, not globally: two people may both value Service.
    it('allows a name another user already has', async () =>
      withUser({ tier: 'premium' }, async (premiumApp) => {
        await createVirtue({ name: 'Service' }, premiumApp.agent);
        await deleteStarterVirtue();

        const res = await app.agent.post('/virtues').send({ name: 'Service' });

        expect(res.status).toBe(StatusCodes.CREATED);
      }));

    // `express-openapi-validator` does not enforce request-body schemas against
    // this OpenAPI 3.1 document, so a missing name reaches the NOT NULL column
    // and has to be mapped back to a 400 rather than surfacing as a 500.
    it('requires a name', async () => {
      await deleteStarterVirtue();

      const res = await app.agent.post('/virtues').send({ icon: 'hammer' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body.message).toMatch(/name is required/);
    });

    it('rejects a colour that is not a hex triplet', async () => {
      await deleteStarterVirtue();

      const res = await app.agent.post('/virtues').send({ name: 'Service', color: 'green' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body.message).toMatch(/hex triplet/);
    });

    it('rejects a name longer than the column allows', async () => {
      await deleteStarterVirtue();

      const res = await app.agent.post('/virtues').send({ name: 'x'.repeat(51) });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('rejects a display_order that is not an integer', async () => {
      await deleteStarterVirtue();

      const res = await app.agent
        .post('/virtues')
        .send({ name: 'Service', display_order: 'first' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('requires authentication', async () => {
      const res = await app.unauthenticatedAgent.post('/virtues').send({ name: 'Service' });

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('PATCH /virtues/{id}', () => {
    it('changes only the fields supplied', async () => {
      const res = await app.agent.patch(`/virtues/${user.virtueIds[0]}`).send({ name: 'Vitality' });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toMatchObject({
        name: 'Vitality',
        icon: 'figure.run',
        color: '#E5533D',
        display_order: 0,
      });
    });

    it('changes the icon, colour, and display order', async () => {
      const res = await app.agent
        .patch(`/virtues/${user.virtueIds[1]}`)
        .send({ icon: 'brain', color: '#123ABC', display_order: 9 });

      expect(res.body).toMatchObject({ icon: 'brain', color: '#123ABC', display_order: 9 });
    });

    it('returns the virtue unchanged for an empty patch', async () => {
      const res = await app.agent.patch(`/virtues/${user.virtueIds[0]}`).send({});

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toMatchObject({ name: 'Body', icon: 'figure.run' });
    });

    // XP and level are derived from the ledger; VirtueUpdate does not expose
    // them, so a client that sends them anyway must not move them.
    it('ignores xp and level in the body', async () => {
      await awardXp(user.virtueIds[0], 120);

      const res = await app.agent
        .patch(`/virtues/${user.virtueIds[0]}`)
        .send({ xp: 99_999, level: 50 });

      expect(res.body).toMatchObject({ xp: 120, level: 2 });
      expect((await virtueRows())[0]).toMatchObject({ xp: 120, level: 2 });
    });

    it('returns 409 when renaming onto a name the user already has', async () => {
      const res = await app.agent.patch(`/virtues/${user.virtueIds[0]}`).send({ name: 'Mind' });

      expect(res.status).toBe(StatusCodes.CONFLICT);
      expect((await virtueRows())[0].name).toBe('Body');
    });

    it('allows a no-op rename to the virtue’s own name', async () => {
      const res = await app.agent.patch(`/virtues/${user.virtueIds[0]}`).send({ name: 'Body' });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body.name).toBe('Body');
    });

    it('rejects a colour that is not a hex triplet', async () => {
      const res = await app.agent.patch(`/virtues/${user.virtueIds[0]}`).send({ color: 'green' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('returns 404 for a virtue that does not exist', async () => {
      const res = await app.agent
        .patch('/virtues/00000000-0000-0000-0000-000000000000')
        .send({ name: 'Nope' });

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's virtue", async () =>
      withUser({}, async (_otherApp, otherUser) => {
        const res = await app.agent
          .patch(`/virtues/${otherUser.virtueIds[0]}`)
          .send({ name: 'Mine now' });

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
      }));

    it('requires authentication', async () => {
      const res = await app.unauthenticatedAgent
        .patch(`/virtues/${user.virtueIds[0]}`)
        .send({ name: 'Vitality' });

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('DELETE /virtues/{id}', () => {
    it('deletes the virtue', async () => {
      const res = await app.agent.delete(`/virtues/${user.virtueIds[0]}`);

      expect(res.status).toBe(StatusCodes.NO_CONTENT);
      expect((await virtueRows()).map((row) => row.name)).toEqual(['Mind', 'Craft', 'Spirit']);
    });

    it('frees a slot under the free-tier cap', async () => {
      await deleteStarterVirtue();

      const res = await app.agent.post('/virtues').send({ name: 'Service' });

      expect(res.status).toBe(StatusCodes.CREATED);
    });

    it('untags routines, goals, and sessions', async () => {
      const virtueId = user.virtueIds[0];
      const routine = await app.agent
        .post('/routines')
        .send({ title: 'Lift', frequency: 'daily', virtue_ids: [virtueId] });
      const goal = await app.agent
        .post('/goals')
        .send({ title: 'Deadlift 200kg', virtue_ids: [virtueId] });
      const session = await app.agent
        .post('/sessions')
        .send({ title: 'Gym', target_duration_minutes: 60, virtue_ids: [virtueId] });
      expect([routine.status, goal.status, session.status]).toEqual([
        StatusCodes.CREATED,
        StatusCodes.CREATED,
        StatusCodes.CREATED,
      ]);

      await app.agent.delete(`/virtues/${virtueId}`);

      const { rows } = await database.client.query<{ count: string }>(
        `select (select count(*) from public.routine_virtues where user_id = $1)
              + (select count(*) from public.goal_virtues    where user_id = $1)
              + (select count(*) from public.session_virtues where user_id = $1) as count`,
        [user.id],
      );
      expect(Number(rows[0].count)).toBe(0);
    });

    // The ledger is append-only: api-spec.yml promises XP already recorded
    // against a deleted virtue is retained, and `profiles.global_xp` is a
    // running total that is never recomputed from the ledger, so cascading the
    // rows away would leave the two unreconcilable.
    it('retains the XP the virtue earned, orphaned from it', async () => {
      await awardXp(user.virtueIds[0], 120);
      const before = await globalXp();

      await app.agent.delete(`/virtues/${user.virtueIds[0]}`);

      expect(await ledger()).toEqual([
        { virtue_id: null, final_xp: 120, description: 'Goal completed: Test' },
      ]);
      expect(await globalXp()).toBe(before);
    });

    it('returns 404 for a virtue that does not exist', async () => {
      const res = await app.agent.delete('/virtues/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's virtue", async () =>
      withUser({}, async (_otherApp, otherUser) => {
        const res = await app.agent.delete(`/virtues/${otherUser.virtueIds[0]}`);

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
        expect(await virtueRows(otherUser.id)).toHaveLength(4);
      }));

    it('requires authentication', async () => {
      const res = await app.unauthenticatedAgent.delete(`/virtues/${user.virtueIds[0]}`);

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('GET /virtues/{id}/history', () => {
    it('returns no points for a virtue that has earned nothing', async () => {
      const res = await app.agent.get(`/virtues/${user.virtueIds[0]}/history`);

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toEqual({ virtue_id: user.virtueIds[0], points: [] });
    });

    it('returns one point per day, with a running total and the level held that day', async () => {
      const [older, newer] = [earlyUtcMorning(5), earlyUtcMorning(3)];
      await recordXp(user.virtueIds[0], 60, older);
      await recordXp(user.virtueIds[0], 50, newer);

      const res = await app.agent.get(`/virtues/${user.virtueIds[0]}/history`);

      expect(res.body.points).toEqual([
        { date: localDate(older, 'UTC'), xp: 60, cumulative_xp: 60, level: 1 },
        { date: localDate(newer, 'UTC'), xp: 50, cumulative_xp: 110, level: 2 },
      ]);
    });

    it('sums several awards on the same day into one point', async () => {
      const day = earlyUtcMorning(2);
      await recordXp(user.virtueIds[0], 40, day);
      await recordXp(user.virtueIds[0], 25, new Date(day.getTime() + 3_600_000));

      const res = await app.agent.get(`/virtues/${user.virtueIds[0]}/history`);

      expect(res.body.points).toEqual([
        { date: localDate(day, 'UTC'), xp: 65, cumulative_xp: 65, level: 1 },
      ]);
    });

    it('ignores XP earned by the user’s other virtues', async () => {
      const day = earlyUtcMorning(2);
      await recordXp(user.virtueIds[0], 40, day);
      await recordXp(user.virtueIds[1], 500, day);

      const res = await app.agent.get(`/virtues/${user.virtueIds[0]}/history`);

      expect(res.body.points).toEqual([
        { date: localDate(day, 'UTC'), xp: 40, cumulative_xp: 40, level: 1 },
      ]);
    });

    // Days are bucketed in the user's own timezone, the way `daily_activity` and
    // the streak logic bucket them, so a late-evening completion belongs to the
    // day the user experienced rather than to UTC's.
    it('buckets a day in the user’s timezone', async () =>
      withUser({ timezone: 'America/New_York' }, async (nyApp, nyUser) => {
        const at = earlyUtcMorning(4);
        await recordXp(nyUser.virtueIds[0], 30, at, nyUser.id);

        const res = await nyApp.agent.get(`/virtues/${nyUser.virtueIds[0]}/history`);

        const local = localDate(at, 'America/New_York');
        expect(local).not.toBe(localDate(at, 'UTC'));
        expect(res.body.points).toEqual([{ date: local, xp: 30, cumulative_xp: 30, level: 1 }]);
      }));

    it('windows the points by from and to, inclusively', async () => {
      const days = [earlyUtcMorning(6), earlyUtcMorning(4), earlyUtcMorning(2)];
      for (const day of days) {
        await recordXp(user.virtueIds[0], 60, day);
      }

      const res = await app.agent
        .get(`/virtues/${user.virtueIds[0]}/history`)
        .query({ from: localDate(days[1], 'UTC'), to: localDate(days[2], 'UTC') });

      expect(res.body.points.map((point: { date: string }) => point.date)).toEqual([
        localDate(days[1], 'UTC'),
        localDate(days[2], 'UTC'),
      ]);
    });

    // A windowed request has to agree with an unwindowed one about what level
    // the user held, so XP earned before `from` is carried in as a baseline
    // rather than dropped.
    it('carries XP earned before the window into the running total', async () => {
      const days = [earlyUtcMorning(6), earlyUtcMorning(4)];
      await recordXp(user.virtueIds[0], 60, days[0]);
      await recordXp(user.virtueIds[0], 50, days[1]);

      const res = await app.agent
        .get(`/virtues/${user.virtueIds[0]}/history`)
        .query({ from: localDate(days[1], 'UTC') });

      expect(res.body.points).toEqual([
        { date: localDate(days[1], 'UTC'), xp: 50, cumulative_xp: 110, level: 2 },
      ]);
    });

    it('returns no points when the window predates every award', async () => {
      await recordXp(user.virtueIds[0], 60, earlyUtcMorning(2));

      const res = await app.agent
        .get(`/virtues/${user.virtueIds[0]}/history`)
        .query({ to: localDate(earlyUtcMorning(10), 'UTC') });

      expect(res.body.points).toEqual([]);
    });

    // The OpenAPI schema cannot relate two parameters to each other, and both
    // bounds are inclusive, so an inverted window is a caller mistake rather
    // than an empty result.
    it('rejects a window that ends before it starts', async () => {
      const res = await app.agent
        .get(`/virtues/${user.virtueIds[0]}/history`)
        .query({ from: '2026-09-10', to: '2026-09-01' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body.message).toMatch(/from must not be later than to/);
    });

    it('rejects a from that is not a calendar date', async () => {
      const res = await app.agent
        .get(`/virtues/${user.virtueIds[0]}/history`)
        .query({ from: '2026-02-30' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('returns 404 for a virtue that does not exist', async () => {
      const res = await app.agent.get('/virtues/00000000-0000-0000-0000-000000000000/history');

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's virtue", async () =>
      withUser({}, async (_otherApp, otherUser) => {
        const res = await app.agent.get(`/virtues/${otherUser.virtueIds[0]}/history`);

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
      }));

    it('requires authentication', async () => {
      const res = await app.unauthenticatedAgent.get(`/virtues/${user.virtueIds[0]}/history`);

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });
});
