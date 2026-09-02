import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StatusCodes } from 'http-status-codes';
import { TempDatabase, createMigratedDatabase, hasDatabase } from '../../db/helpers';
import { seedUser, SeededUser } from './fixtures';
import { createRoutineTestApp, RoutineTestApp } from './helpers';

describe.skipIf(!hasDatabase)('routines', () => {
  let database: TempDatabase;
  let user: SeededUser;
  let app: RoutineTestApp;

  beforeAll(async () => {
    database = await createMigratedDatabase('routines');
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  // Every test gets its own freshly seeded user (and therefore its own empty
  // set of routines and untouched free-tier cap), so tests never depend on
  // ordering or on what an earlier test left behind.
  beforeEach(async () => {
    user = await seedUser(database.client);
    app = createRoutineTestApp(database.url, user.id);
  });

  afterEach(async () => {
    await app.dependencies.pool.end();
  });

  async function withOtherUser<T>(
    fn: (other: RoutineTestApp, otherUser: SeededUser) => Promise<T>,
  ): Promise<T> {
    const otherUser = await seedUser(database.client);
    const otherApp = createRoutineTestApp(database.url, otherUser.id);
    try {
      return await fn(otherApp, otherUser);
    } finally {
      await otherApp.dependencies.pool.end();
    }
  }

  describe('POST /routines', () => {
    it('creates a daily routine, defaulting base_xp for the frequency', async () => {
      const res = await app.agent.post('/routines').send({
        title: 'Morning run',
        description: 'A 20 minute jog before breakfast',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });

      expect(res.status).toBe(StatusCodes.CREATED);
      expect(res.body).toMatchObject({
        title: 'Morning run',
        description: 'A 20 minute jog before breakfast',
        frequency: 'daily',
        scheduled_day: null,
        base_xp: 10,
        is_active: true,
        virtue_ids: [user.virtueIds[0]],
      });
      expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('defaults description to null when omitted', async () => {
      const res = await app.agent.post('/routines').send({
        title: 'No description routine',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });

      expect(res.status).toBe(StatusCodes.CREATED);
      expect(res.body.description).toBeNull();
    });

    it('defaults base_xp for weekly and monthly routines', async () => {
      const weekly = await app.agent.post('/routines').send({
        title: 'Weekly review',
        frequency: 'weekly',
        scheduled_day: 0,
        virtue_ids: [user.virtueIds[0]],
      });
      expect(weekly.body.base_xp).toBe(25);

      const monthly = await app.agent.post('/routines').send({
        title: 'Monthly budget',
        frequency: 'monthly',
        scheduled_day: 1,
        virtue_ids: [user.virtueIds[0]],
      });
      expect(monthly.body.base_xp).toBe(50);
    });

    it('accepts an explicit base_xp override', async () => {
      const res = await app.agent.post('/routines').send({
        title: 'Custom XP routine',
        frequency: 'daily',
        base_xp: 42,
        virtue_ids: [user.virtueIds[0]],
      });

      expect(res.status).toBe(StatusCodes.CREATED);
      expect(res.body.base_xp).toBe(42);
    });

    it('tags multiple virtues', async () => {
      const res = await app.agent.post('/routines').send({
        title: 'Multi-virtue routine',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0], user.virtueIds[1]],
      });

      expect(res.status).toBe(StatusCodes.CREATED);
      expect(res.body.virtue_ids.sort()).toEqual([user.virtueIds[0], user.virtueIds[1]].sort());
    });

    it('rejects a daily routine with a scheduled_day', async () => {
      const res = await app.agent.post('/routines').send({
        title: 'Bad daily',
        frequency: 'daily',
        scheduled_day: 2,
        virtue_ids: [user.virtueIds[0]],
      });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('rejects a weekly routine missing scheduled_day', async () => {
      const res = await app.agent.post('/routines').send({
        title: 'Bad weekly',
        frequency: 'weekly',
        virtue_ids: [user.virtueIds[0]],
      });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('rejects an out-of-range scheduled_day for the frequency', async () => {
      const res = await app.agent.post('/routines').send({
        title: 'Bad range',
        frequency: 'weekly',
        scheduled_day: 9,
        virtue_ids: [user.virtueIds[0]],
      });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('rejects duplicate virtue_ids', async () => {
      const res = await app.agent.post('/routines').send({
        title: 'Dup virtues',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0], user.virtueIds[0]],
      });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('rejects a virtue_id that belongs to another user', async () =>
      withOtherUser(async (_otherApp, otherUser) => {
        const res = await app.agent.post('/routines').send({
          title: 'Foreign virtue',
          frequency: 'daily',
          virtue_ids: [otherUser.virtueIds[0]],
        });

        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      }));

    it('rejects an unauthenticated request', async () => {
      const res = await app.unauthenticatedAgent.post('/routines').send({
        title: 'No auth',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });

    it('returns 402 once the free-tier active routine cap is exceeded', async () => {
      for (let i = 0; i < 10; i += 1) {
        const res = await app.agent.post('/routines').send({
          title: `Cap routine ${i}`,
          frequency: 'daily',
          virtue_ids: [user.virtueIds[0]],
        });
        expect(res.status).toBe(StatusCodes.CREATED);
      }

      const over = await app.agent.post('/routines').send({
        title: 'One too many',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });

      expect(over.status).toBe(StatusCodes.PAYMENT_REQUIRED);
    });
  });

  describe('GET /routines', () => {
    it("lists only the caller's routines", async () =>
      withOtherUser(async (otherApp) => {
        const mine = await app.agent.post('/routines').send({
          title: 'Listable routine',
          frequency: 'daily',
          virtue_ids: [user.virtueIds[0]],
        });
        expect(mine.status).toBe(StatusCodes.CREATED);

        const res = await app.agent.get('/routines');

        expect(res.status).toBe(StatusCodes.OK);
        expect(res.body.map((r: { id: string }) => r.id)).toContain(mine.body.id);

        const otherRes = await otherApp.agent.get('/routines');
        expect(otherRes.body.map((r: { id: string }) => r.id)).not.toContain(mine.body.id);
      }));

    it('filters by frequency', async () => {
      const weekly = await app.agent.post('/routines').send({
        title: 'Weekly for filter test',
        frequency: 'weekly',
        scheduled_day: 0,
        virtue_ids: [user.virtueIds[0]],
      });
      const daily = await app.agent.post('/routines').send({
        title: 'Daily for filter test',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });
      expect(weekly.status).toBe(StatusCodes.CREATED);
      expect(daily.status).toBe(StatusCodes.CREATED);

      const res = await app.agent.get('/routines').query({ frequency: 'weekly' });

      expect(res.status).toBe(StatusCodes.OK);
      const ids = res.body.map((r: { id: string }) => r.id);
      expect(ids).toContain(weekly.body.id);
      expect(ids).not.toContain(daily.body.id);
      for (const routine of res.body) {
        expect(routine.frequency).toBe('weekly');
      }
    });

    it('filters by is_active', async () => {
      const res = await app.agent.get('/routines').query({ is_active: 'true' });

      expect(res.status).toBe(StatusCodes.OK);
      for (const routine of res.body) {
        expect(routine.is_active).toBe(true);
      }
    });
  });

  describe('POST /routines/{id}/complete', () => {
    it('awards XP, applying the streak and virtue-count multipliers', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'Completion routine',
        frequency: 'daily',
        base_xp: 10,
        virtue_ids: [user.virtueIds[0]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const res = await app.agent.post(`/routines/${created.body.id}/complete`);

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toMatchObject({
        xp_earned: 10,
        base_xp: 10,
        streak_multiplier: 1,
        virtue_bonus: 1,
        per_virtue_xp: 10,
        global_xp: 10,
        global_level: 1,
        current_streak: 0,
      });
      expect(res.body.ledger_entry_ids).toHaveLength(1);
    });

    it('rejects a completed_at the OpenAPI validator lets through but Postgres cannot parse', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'Invalid completed_at routine',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const res = await app.agent
        .post(`/routines/${created.body.id}/complete`)
        .send({ completed_at: 'not-a-date' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('rejects completing the same routine twice for the same period', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'Double completion routine',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const first = await app.agent.post(`/routines/${created.body.id}/complete`);
      expect(first.status).toBe(StatusCodes.OK);

      const second = await app.agent.post(`/routines/${created.body.id}/complete`);
      expect(second.status).toBe(StatusCodes.CONFLICT);
    });

    it('returns 404 for a routine that does not exist', async () => {
      const res = await app.agent.post('/routines/00000000-0000-0000-0000-000000000000/complete');

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's routine", async () =>
      withOtherUser(async (otherApp) => {
        const created = await app.agent.post('/routines').send({
          title: 'Owner-only routine',
          frequency: 'daily',
          virtue_ids: [user.virtueIds[0]],
        });
        expect(created.status).toBe(StatusCodes.CREATED);

        const res = await otherApp.agent.post(`/routines/${created.body.id}/complete`);

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
      }));

    it('applies the multi-virtue bonus when multiple virtues are tagged', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'Two virtue routine',
        frequency: 'daily',
        base_xp: 10,
        virtue_ids: [user.virtueIds[2], user.virtueIds[3]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const res = await app.agent.post(`/routines/${created.body.id}/complete`);

      expect(res.status).toBe(StatusCodes.OK);
      // virtue_bonus = 1.0 + 0.10 * (virtue_count - 1) = 1.10 for two virtues.
      expect(res.body.virtue_bonus).toBeCloseTo(1.1);
      expect(res.body.xp_earned).toBe(11);
    });
  });
});
