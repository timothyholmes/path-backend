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

  describe('PATCH /routines/{id}', () => {
    it('updates only the supplied fields, leaving the rest untouched', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'Original title',
        description: 'Original description',
        frequency: 'daily',
        base_xp: 20,
        virtue_ids: [user.virtueIds[0]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const res = await app.agent.patch(`/routines/${created.body.id}`).send({
        title: 'Updated title',
      });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toMatchObject({
        id: created.body.id,
        title: 'Updated title',
        description: 'Original description',
        frequency: 'daily',
        base_xp: 20,
        is_active: true,
        virtue_ids: [user.virtueIds[0]],
      });
    });

    it('updates base_xp', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'XP override routine',
        frequency: 'daily',
        base_xp: 10,
        virtue_ids: [user.virtueIds[0]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const res = await app.agent.patch(`/routines/${created.body.id}`).send({ base_xp: 99 });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body.base_xp).toBe(99);
    });

    it('is a no-op that returns the current state when the patch is empty', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'Untouched routine',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const res = await app.agent.patch(`/routines/${created.body.id}`).send({});

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toEqual(created.body);
    });

    it('clears description by setting it to null', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'Has a description',
        description: 'Will be cleared',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const res = await app.agent.patch(`/routines/${created.body.id}`).send({ description: null });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body.description).toBeNull();
    });

    it('replaces tagged virtues when virtue_ids is supplied', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'Retagged routine',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const res = await app.agent
        .patch(`/routines/${created.body.id}`)
        .send({ virtue_ids: [user.virtueIds[1], user.virtueIds[2]] });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body.virtue_ids.sort()).toEqual([user.virtueIds[1], user.virtueIds[2]].sort());
    });

    it('changes frequency together with a valid scheduled_day', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'Frequency change routine',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const res = await app.agent
        .patch(`/routines/${created.body.id}`)
        .send({ frequency: 'weekly', scheduled_day: 3 });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toMatchObject({ frequency: 'weekly', scheduled_day: 3 });
    });

    it('rejects changing frequency without a compatible scheduled_day', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'Bad frequency change routine',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const res = await app.agent
        .patch(`/routines/${created.body.id}`)
        .send({ frequency: 'weekly' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('rejects duplicate virtue_ids', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'Dup update routine',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const res = await app.agent
        .patch(`/routines/${created.body.id}`)
        .send({ virtue_ids: [user.virtueIds[1], user.virtueIds[1]] });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('rejects a virtue_id that belongs to another user', async () =>
      withOtherUser(async (_otherApp, otherUser) => {
        const created = await app.agent.post('/routines').send({
          title: 'Foreign retag routine',
          frequency: 'daily',
          virtue_ids: [user.virtueIds[0]],
        });
        expect(created.status).toBe(StatusCodes.CREATED);

        const res = await app.agent
          .patch(`/routines/${created.body.id}`)
          .send({ virtue_ids: [otherUser.virtueIds[0]] });

        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      }));

    it('returns 402 when reactivating a routine would exceed the free-tier cap', async () => {
      const spare = await app.agent.post('/routines').send({
        title: 'Spare routine',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });
      expect(spare.status).toBe(StatusCodes.CREATED);

      const deactivated = await app.agent
        .patch(`/routines/${spare.body.id}`)
        .send({ is_active: false });
      expect(deactivated.status).toBe(StatusCodes.OK);
      expect(deactivated.body.is_active).toBe(false);

      for (let i = 0; i < 10; i += 1) {
        const res = await app.agent.post('/routines').send({
          title: `Cap filler ${i}`,
          frequency: 'daily',
          virtue_ids: [user.virtueIds[0]],
        });
        expect(res.status).toBe(StatusCodes.CREATED);
      }

      const reactivated = await app.agent
        .patch(`/routines/${spare.body.id}`)
        .send({ is_active: true });

      expect(reactivated.status).toBe(StatusCodes.PAYMENT_REQUIRED);
    });

    it('returns 404 for a routine that does not exist', async () => {
      const res = await app.agent
        .patch('/routines/00000000-0000-0000-0000-000000000000')
        .send({ title: 'Nope' });

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's routine and leaves it unmodified", async () =>
      withOtherUser(async (otherApp) => {
        const created = await app.agent.post('/routines').send({
          title: 'Not yours',
          frequency: 'daily',
          virtue_ids: [user.virtueIds[0]],
        });
        expect(created.status).toBe(StatusCodes.CREATED);

        const res = await otherApp.agent
          .patch(`/routines/${created.body.id}`)
          .send({ title: 'Hijacked' });
        expect(res.status).toBe(StatusCodes.NOT_FOUND);

        const list = await app.agent.get('/routines');
        const mine = list.body.find((r: { id: string }) => r.id === created.body.id);
        expect(mine.title).toBe('Not yours');
      }));

    it('rejects an unauthenticated request', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'Auth check routine',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const res = await app.unauthenticatedAgent
        .patch(`/routines/${created.body.id}`)
        .send({ title: 'Should not work' });

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('DELETE /routines/{id}', () => {
    it('deletes a routine and cascades its virtue tags and completion history', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'Deletable routine',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const completed = await app.agent.post(`/routines/${created.body.id}/complete`);
      expect(completed.status).toBe(StatusCodes.OK);

      const res = await app.agent.delete(`/routines/${created.body.id}`);
      expect(res.status).toBe(StatusCodes.NO_CONTENT);
      expect(res.body).toEqual({});

      const list = await app.agent.get('/routines');
      expect(list.body.map((r: { id: string }) => r.id)).not.toContain(created.body.id);

      const { rows: virtueRows } = await database.client.query(
        'select 1 from public.routine_virtues where routine_id = $1',
        [created.body.id],
      );
      expect(virtueRows).toHaveLength(0);

      const { rows: completionRows } = await database.client.query(
        'select 1 from public.routine_completions where routine_id = $1',
        [created.body.id],
      );
      expect(completionRows).toHaveLength(0);
    });

    it('returns 404 for a routine that does not exist', async () => {
      const res = await app.agent.delete('/routines/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's routine and leaves it in place", async () =>
      withOtherUser(async (otherApp) => {
        const created = await app.agent.post('/routines').send({
          title: 'Not yours to delete',
          frequency: 'daily',
          virtue_ids: [user.virtueIds[0]],
        });
        expect(created.status).toBe(StatusCodes.CREATED);

        const res = await otherApp.agent.delete(`/routines/${created.body.id}`);
        expect(res.status).toBe(StatusCodes.NOT_FOUND);

        const list = await app.agent.get('/routines');
        expect(list.body.map((r: { id: string }) => r.id)).toContain(created.body.id);
      }));

    it('rejects an unauthenticated request', async () => {
      const created = await app.agent.post('/routines').send({
        title: 'Auth check delete routine',
        frequency: 'daily',
        virtue_ids: [user.virtueIds[0]],
      });
      expect(created.status).toBe(StatusCodes.CREATED);

      const res = await app.unauthenticatedAgent.delete(`/routines/${created.body.id}`);

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });
});
