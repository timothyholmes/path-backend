import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StatusCodes } from 'http-status-codes';
import { TempDatabase, createMigratedDatabase, hasDatabase } from '../../db/helpers';
import { seedUser, SeedUserOptions, SeededUser } from '../shared/fixtures';
import { createDbTestApp, DbTestApp } from '../shared/testApp';

interface InstanceRow {
  id: string;
  scheduled_at: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  actual_duration_seconds: number | null;
  status: string;
  xp_earned: number | null;
  skip_penalty_xp: number | null;
  focus_mode_activated: boolean;
}

describe.skipIf(!hasDatabase)('sessions', () => {
  let database: TempDatabase;
  let user: SeededUser;
  let app: DbTestApp;

  beforeAll(async () => {
    database = await createMigratedDatabase('sessions');
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  // Every test gets its own freshly seeded user (and therefore its own empty
  // set of sessions and untouched XP totals), so tests never depend on ordering
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

  /** Creates a session through the API and returns its body, failing loudly if the create didn't. */
  async function createSession(
    body: Record<string, unknown> = {},
    agent = app.agent,
    virtueIds = user.virtueIds,
  ) {
    const res = await agent.post('/sessions').send({
      title: 'Deep work',
      target_duration_minutes: 60,
      virtue_ids: [virtueIds[0]],
      ...body,
    });
    expect(res.status).toBe(StatusCodes.CREATED);
    return res.body;
  }

  /** A `scheduled` instance, as recurrence expansion would have written it. */
  async function scheduleInstance(sessionId: string, scheduledAt: Date, userId = user.id) {
    const { rows } = await database.client.query<{ id: string }>(
      `insert into public.session_instances (session_id, user_id, scheduled_at, status)
       values ($1, $2, $3, 'scheduled')
       returning id`,
      [sessionId, userId, scheduledAt],
    );
    return rows[0].id;
  }

  async function instances(sessionId: string): Promise<InstanceRow[]> {
    const { rows } = await database.client.query<InstanceRow>(
      `select id, scheduled_at, started_at, ended_at, actual_duration_seconds, status,
              xp_earned, skip_penalty_xp, focus_mode_activated
         from public.session_instances
        where session_id = $1
        order by created_at`,
      [sessionId],
    );
    return rows;
  }

  describe('POST /sessions', () => {
    it('creates a session, defaulting base_xp from the target duration', async () => {
      const res = await app.agent.post('/sessions').send({
        title: 'Deep work',
        target_duration_minutes: 90,
        virtue_ids: [user.virtueIds[0]],
      });

      expect(res.status).toBe(StatusCodes.CREATED);
      expect(res.body).toMatchObject({
        user_id: user.id,
        title: 'Deep work',
        target_duration_minutes: 90,
        recurrence_rule: null,
        base_xp: 100,
        is_active: true,
        virtue_ids: [user.virtueIds[0]],
      });
      expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('defaults base_xp for each standard duration', async () => {
      const thirty = await createSession({ title: '30', target_duration_minutes: 30 });
      const sixty = await createSession({ title: '60', target_duration_minutes: 60 });

      expect(thirty.base_xp).toBe(40);
      expect(sixty.base_xp).toBe(75);
    });

    it('accepts an explicit base_xp override', async () => {
      const session = await createSession({ base_xp: 42 });

      expect(session.base_xp).toBe(42);
    });

    it('stores a recurrence rule verbatim', async () => {
      const rule = { freq: 'WEEKLY', byday: ['MO', 'WE', 'FR'] };
      const session = await createSession({ recurrence_rule: rule });

      expect(session.recurrence_rule).toEqual(rule);
    });

    it('tags multiple virtues', async () => {
      const session = await createSession({
        virtue_ids: [user.virtueIds[0], user.virtueIds[1]],
      });

      expect(session.virtue_ids.sort()).toEqual([user.virtueIds[0], user.virtueIds[1]].sort());
    });

    it('rejects duplicate virtue_ids', async () => {
      const res = await app.agent.post('/sessions').send({
        title: 'Duplicate virtues',
        target_duration_minutes: 60,
        virtue_ids: [user.virtueIds[0], user.virtueIds[0]],
      });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('rejects a virtue_id that belongs to another user', async () =>
      withUser({}, async (_otherApp, otherUser) => {
        const res = await app.agent.post('/sessions').send({
          title: 'Borrowed virtue',
          target_duration_minutes: 60,
          virtue_ids: [otherUser.virtueIds[0]],
        });

        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      }));

    it('rejects a non-positive target duration the schema lets through', async () => {
      const res = await app.agent.post('/sessions').send({
        title: 'Zero length',
        target_duration_minutes: 0,
        virtue_ids: [user.virtueIds[0]],
      });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('returns 402 for a custom duration on the free plan', async () => {
      const res = await app.agent.post('/sessions').send({
        title: 'Custom length',
        target_duration_minutes: 45,
        virtue_ids: [user.virtueIds[0]],
      });

      expect(res.status).toBe(StatusCodes.PAYMENT_REQUIRED);

      const { rows } = await database.client.query(
        `select 1 from public.sessions where user_id = $1`,
        [user.id],
      );
      expect(rows).toHaveLength(0);
    });

    it('allows a custom duration for a premium user, interpolating base_xp', async () =>
      withUser({ tier: 'premium' }, async (premium, premiumUser) => {
        const res = await premium.agent.post('/sessions').send({
          title: 'Custom length',
          target_duration_minutes: 45,
          virtue_ids: [premiumUser.virtueIds[0]],
        });

        expect(res.status).toBe(StatusCodes.CREATED);
        // default_session_xp interpolates off the 30-minute rate: floor(45 * 40 / 30).
        expect(res.body.base_xp).toBe(60);
      }));

    it('returns 402 for a custom duration once premium has lapsed', async () =>
      withUser(
        { tier: 'premium', subscriptionExpiresAt: new Date(Date.now() - 60_000) },
        async (lapsed, lapsedUser) => {
          const res = await lapsed.agent.post('/sessions').send({
            title: 'Custom length',
            target_duration_minutes: 45,
            virtue_ids: [lapsedUser.virtueIds[0]],
          });

          expect(res.status).toBe(StatusCodes.PAYMENT_REQUIRED);
        },
      ));

    it('rejects an unauthenticated request', async () => {
      const res = await app.unauthenticatedAgent.post('/sessions').send({
        title: 'Anonymous',
        target_duration_minutes: 60,
        virtue_ids: [user.virtueIds[0]],
      });

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('GET /sessions', () => {
    it("lists only the caller's sessions", async () =>
      withUser({}, async (otherApp, otherUser) => {
        await createSession({ title: 'Mine' });
        await createSession({ title: 'Theirs' }, otherApp.agent, otherUser.virtueIds);

        const res = await app.agent.get('/sessions');

        expect(res.status).toBe(StatusCodes.OK);
        expect(res.body.map((session: { title: string }) => session.title)).toEqual(['Mine']);
      }));

    it('filters by is_active', async () => {
      const active = await createSession({ title: 'Active' });
      const retired = await createSession({ title: 'Retired' });
      await app.agent.patch(`/sessions/${retired.id}`).send({ is_active: false });

      const activeOnly = await app.agent.get('/sessions').query({ is_active: true });
      expect(activeOnly.body.map((session: { id: string }) => session.id)).toEqual([active.id]);

      const inactiveOnly = await app.agent.get('/sessions').query({ is_active: false });
      expect(inactiveOnly.body.map((session: { id: string }) => session.id)).toEqual([retired.id]);
    });

    it('returns tagged virtues for each session', async () => {
      await createSession({ virtue_ids: [user.virtueIds[0], user.virtueIds[1]] });

      const res = await app.agent.get('/sessions');

      expect(res.body[0].virtue_ids.sort()).toEqual([user.virtueIds[0], user.virtueIds[1]].sort());
    });

    it('rejects an unauthenticated request', async () => {
      const res = await app.unauthenticatedAgent.get('/sessions');

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('PATCH /sessions/{id}', () => {
    it('updates only the supplied fields, leaving the rest untouched', async () => {
      const session = await createSession({
        title: 'Before',
        recurrence_rule: { freq: 'DAILY' },
      });

      const res = await app.agent.patch(`/sessions/${session.id}`).send({ title: 'After' });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toMatchObject({
        title: 'After',
        target_duration_minutes: 60,
        recurrence_rule: { freq: 'DAILY' },
        base_xp: 75,
        is_active: true,
        virtue_ids: [user.virtueIds[0]],
      });
    });

    it('is a no-op that returns the current state when the patch is empty', async () => {
      const session = await createSession();

      const res = await app.agent.patch(`/sessions/${session.id}`).send({});

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toEqual(session);
    });

    it('clears the recurrence rule by setting it to null', async () => {
      const session = await createSession({ recurrence_rule: { freq: 'DAILY' } });

      const res = await app.agent.patch(`/sessions/${session.id}`).send({ recurrence_rule: null });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body.recurrence_rule).toBeNull();
    });

    it('replaces tagged virtues when virtue_ids is supplied', async () => {
      const session = await createSession({ virtue_ids: [user.virtueIds[0]] });

      const res = await app.agent
        .patch(`/sessions/${session.id}`)
        .send({ virtue_ids: [user.virtueIds[2]] });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body.virtue_ids).toEqual([user.virtueIds[2]]);
    });

    it('leaves base_xp alone when the duration changes, since the default is insert-only', async () => {
      const session = await createSession({ target_duration_minutes: 30 });
      expect(session.base_xp).toBe(40);

      const res = await app.agent
        .patch(`/sessions/${session.id}`)
        .send({ target_duration_minutes: 90 });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toMatchObject({ target_duration_minutes: 90, base_xp: 40 });
    });

    it('updates base_xp when it is supplied explicitly', async () => {
      const session = await createSession();

      const res = await app.agent.patch(`/sessions/${session.id}`).send({ base_xp: 5 });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body.base_xp).toBe(5);
    });

    it('returns 402 when switching to a custom duration on the free plan', async () => {
      const session = await createSession();

      const res = await app.agent
        .patch(`/sessions/${session.id}`)
        .send({ title: 'Custom', target_duration_minutes: 45 });

      expect(res.status).toBe(StatusCodes.PAYMENT_REQUIRED);

      const unchanged = await app.agent.get('/sessions');
      expect(unchanged.body[0]).toMatchObject({ title: 'Deep work', target_duration_minutes: 60 });
    });

    it('allows a premium user to switch to a custom duration', async () =>
      withUser({ tier: 'premium' }, async (premium, premiumUser) => {
        const session = await createSession({}, premium.agent, premiumUser.virtueIds);

        const res = await premium.agent
          .patch(`/sessions/${session.id}`)
          .send({ target_duration_minutes: 45 });

        expect(res.status).toBe(StatusCodes.OK);
        expect(res.body.target_duration_minutes).toBe(45);
      }));

    it('rejects duplicate virtue_ids', async () => {
      const session = await createSession();

      const res = await app.agent
        .patch(`/sessions/${session.id}`)
        .send({ virtue_ids: [user.virtueIds[1], user.virtueIds[1]] });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('rejects a virtue_id that belongs to another user', async () =>
      withUser({}, async (_otherApp, otherUser) => {
        const session = await createSession();

        const res = await app.agent
          .patch(`/sessions/${session.id}`)
          .send({ virtue_ids: [otherUser.virtueIds[0]] });

        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      }));

    it('rejects a non-positive target duration the schema lets through', async () => {
      const session = await createSession();

      const res = await app.agent
        .patch(`/sessions/${session.id}`)
        .send({ target_duration_minutes: -30 });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('returns 404 for a session that does not exist', async () => {
      const res = await app.agent
        .patch('/sessions/00000000-0000-0000-0000-000000000000')
        .send({ title: 'Ghost' });

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's session and leaves it unmodified", async () =>
      withUser({}, async (otherApp) => {
        const session = await createSession({ title: 'Owner only' });

        const res = await otherApp.agent
          .patch(`/sessions/${session.id}`)
          .send({ title: 'Hijacked' });

        expect(res.status).toBe(StatusCodes.NOT_FOUND);

        const mine = await app.agent.get('/sessions');
        expect(mine.body[0].title).toBe('Owner only');
      }));

    it('rejects an unauthenticated request', async () => {
      const session = await createSession();

      const res = await app.unauthenticatedAgent
        .patch(`/sessions/${session.id}`)
        .send({ title: 'Anonymous' });

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('DELETE /sessions/{id}', () => {
    it('deletes a session and cascades its virtue tags and instances', async () => {
      const session = await createSession();
      await app.agent.post(`/sessions/${session.id}/start`);

      const res = await app.agent.delete(`/sessions/${session.id}`);

      expect(res.status).toBe(StatusCodes.NO_CONTENT);

      const { rows: tags } = await database.client.query(
        `select 1 from public.session_virtues where session_id = $1`,
        [session.id],
      );
      expect(tags).toHaveLength(0);
      expect(await instances(session.id)).toHaveLength(0);
    });

    it('returns 404 for a session that does not exist', async () => {
      const res = await app.agent.delete('/sessions/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's session and leaves it in place", async () =>
      withUser({}, async (otherApp) => {
        const session = await createSession();

        const res = await otherApp.agent.delete(`/sessions/${session.id}`);

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
        const mine = await app.agent.get('/sessions');
        expect(mine.body).toHaveLength(1);
      }));

    it('rejects an unauthenticated request', async () => {
      const session = await createSession();

      const res = await app.unauthenticatedAgent.delete(`/sessions/${session.id}`);

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('POST /sessions/{id}/start', () => {
    it('starts an ad-hoc instance and returns the timer state', async () => {
      const session = await createSession();

      const res = await app.agent.post(`/sessions/${session.id}/start`);

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body.target_duration_seconds).toBe(3600);
      expect(res.body.instance).toMatchObject({
        session_id: session.id,
        user_id: user.id,
        scheduled_at: null,
        ended_at: null,
        status: 'in_progress',
        xp_earned: null,
        focus_mode_activated: false,
      });
      expect(Date.parse(res.body.instance.started_at)).not.toBeNaN();
      expect(Date.parse(res.body.server_time)).not.toBeNaN();
    });

    it('records that focus mode was activated', async () => {
      const session = await createSession();

      const res = await app.agent
        .post(`/sessions/${session.id}/start`)
        .send({ focus_mode_activated: true });

      expect(res.body.instance.focus_mode_activated).toBe(true);
    });

    it('resumes the running instance instead of starting a second one', async () => {
      const session = await createSession();

      const first = await app.agent.post(`/sessions/${session.id}/start`);
      const second = await app.agent.post(`/sessions/${session.id}/start`);

      expect(second.status).toBe(StatusCodes.OK);
      expect(second.body.instance.id).toBe(first.body.instance.id);
      expect(second.body.instance.started_at).toBe(first.body.instance.started_at);
      expect(await instances(session.id)).toHaveLength(1);
    });

    // Two clients (phone and web, say) can start the same session at the same
    // instant. Driving storage directly is what makes their transactions
    // genuinely overlap: over HTTP the two requests stagger and the race never
    // shows up. Without the session row lock both transactions see no running
    // instance and each insert one.
    it('serialises concurrent starts into a single instance', async () => {
      const session = await createSession();
      const storage = app.dependencies.sessionStorage;

      const [first, second] = await Promise.all([
        storage.start(user.id, session.id, false),
        storage.start(user.id, session.id, false),
      ]);

      expect(second.instance.id).toBe(first.instance.id);
      expect(await instances(session.id)).toHaveLength(1);
    });

    it('claims the pending scheduled instance nearest to now', async () => {
      const session = await createSession({ recurrence_rule: { freq: 'DAILY' } });
      const stale = await scheduleInstance(session.id, new Date(Date.now() - 3 * 86_400_000));
      const today = await scheduleInstance(session.id, new Date(Date.now() - 60_000));

      const res = await app.agent.post(`/sessions/${session.id}/start`);

      expect(res.body.instance.id).toBe(today);
      expect(res.body.instance.status).toBe('in_progress');
      expect(res.body.instance.scheduled_at).not.toBeNull();

      const rows = await instances(session.id);
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === stale)?.status).toBe('scheduled');
    });

    it('returns 404 for a session that does not exist', async () => {
      const res = await app.agent.post('/sessions/00000000-0000-0000-0000-000000000000/start');

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's session", async () =>
      withUser({}, async (otherApp) => {
        const session = await createSession();

        const res = await otherApp.agent.post(`/sessions/${session.id}/start`);

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
        expect(await instances(session.id)).toHaveLength(0);
      }));

    it('rejects an unauthenticated request', async () => {
      const session = await createSession();

      const res = await app.unauthenticatedAgent.post(`/sessions/${session.id}/start`);

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('POST /sessions/{id}/end', () => {
    it('awards the full base XP for a session run to its target', async () => {
      const session = await createSession();
      await app.agent.post(`/sessions/${session.id}/start`);

      const res = await app.agent
        .post(`/sessions/${session.id}/end`)
        .send({ actual_duration_seconds: 3600 });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toMatchObject({
        xp_earned: 75,
        base_xp: 75,
        streak_multiplier: 1,
        virtue_bonus: 1,
        global_xp: 75,
        global_level: 1,
      });

      const [instance] = await instances(session.id);
      expect(instance).toMatchObject({
        status: 'completed',
        actual_duration_seconds: 3600,
        xp_earned: 75,
      });
      expect(instance.ended_at).not.toBeNull();
    });

    it('awards proportional XP when the session is ended early', async () => {
      const session = await createSession();
      await app.agent.post(`/sessions/${session.id}/start`);

      const res = await app.agent
        .post(`/sessions/${session.id}/end`)
        .send({ actual_duration_seconds: 1800 });

      // floor(75 * 1800/3600) = 37.
      expect(res.body).toMatchObject({ base_xp: 37, xp_earned: 37 });
    });

    it('does not award more than the full base XP for overrunning the target', async () => {
      const session = await createSession();
      await app.agent.post(`/sessions/${session.id}/start`);

      const res = await app.agent
        .post(`/sessions/${session.id}/end`)
        .send({ actual_duration_seconds: 7200 });

      expect(res.body).toMatchObject({ base_xp: 75, xp_earned: 75 });
      const [instance] = await instances(session.id);
      expect(instance.actual_duration_seconds).toBe(7200);
    });

    it('measures the duration from the instance start when none is supplied', async () => {
      const session = await createSession();
      await app.agent.post(`/sessions/${session.id}/start`);

      const res = await app.agent.post(`/sessions/${session.id}/end`);

      expect(res.status).toBe(StatusCodes.OK);
      // A session ended immediately has earned essentially no time, so no XP.
      expect(res.body.xp_earned).toBe(0);

      const [instance] = await instances(session.id);
      expect(instance.status).toBe('completed');
      expect(instance.actual_duration_seconds).toBeGreaterThanOrEqual(0);
      expect(instance.actual_duration_seconds).toBeLessThan(60);
    });

    it('applies the multi-virtue bonus to the proportional award', async () => {
      const session = await createSession({
        virtue_ids: [user.virtueIds[0], user.virtueIds[1]],
      });
      await app.agent.post(`/sessions/${session.id}/start`);

      const res = await app.agent
        .post(`/sessions/${session.id}/end`)
        .send({ actual_duration_seconds: 3600 });

      expect(res.body.virtue_bonus).toBeCloseTo(1.1);
      expect(res.body.xp_earned).toBe(82);
      expect(res.body.ledger_entry_ids).toHaveLength(2);
    });

    it('completes the instance it claimed from the schedule', async () => {
      const session = await createSession({ recurrence_rule: { freq: 'DAILY' } });
      const scheduled = await scheduleInstance(session.id, new Date());
      await app.agent.post(`/sessions/${session.id}/start`);

      const res = await app.agent
        .post(`/sessions/${session.id}/end`)
        .send({ actual_duration_seconds: 3600 });

      expect(res.status).toBe(StatusCodes.OK);
      const rows = await instances(session.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: scheduled, status: 'completed' });
    });

    it('returns 409 when the session has no instance running', async () => {
      const session = await createSession();

      const res = await app.agent.post(`/sessions/${session.id}/end`);

      expect(res.status).toBe(StatusCodes.CONFLICT);
    });

    it('returns 409 when the running instance has already been ended', async () => {
      const session = await createSession();
      await app.agent.post(`/sessions/${session.id}/start`);
      await app.agent.post(`/sessions/${session.id}/end`).send({ actual_duration_seconds: 60 });

      const res = await app.agent.post(`/sessions/${session.id}/end`);

      expect(res.status).toBe(StatusCodes.CONFLICT);
    });

    it('returns 404 for a session that does not exist', async () => {
      const res = await app.agent.post('/sessions/00000000-0000-0000-0000-000000000000/end');

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's running session", async () =>
      withUser({}, async (otherApp) => {
        const session = await createSession();
        await app.agent.post(`/sessions/${session.id}/start`);

        const res = await otherApp.agent.post(`/sessions/${session.id}/end`);

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
        const [instance] = await instances(session.id);
        expect(instance.status).toBe('in_progress');
      }));

    it('rejects an unauthenticated request', async () => {
      const session = await createSession();

      const res = await app.unauthenticatedAgent.post(`/sessions/${session.id}/end`);

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('POST /sessions/{id}/skip', () => {
    it('skips the scheduled instance and logs a quarter-base penalty', async () => {
      const session = await createSession({ target_duration_minutes: 30 });
      const scheduled = await scheduleInstance(session.id, new Date());

      const res = await app.agent.post(`/sessions/${session.id}/skip`);

      expect(res.status).toBe(StatusCodes.OK);
      // floor(40 * 0.25) = 10, logged as a negative, un-multiplied entry.
      expect(res.body).toMatchObject({
        xp_earned: -10,
        base_xp: -10,
        streak_multiplier: 1,
        global_xp: -10,
      });

      const rows = await instances(session.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: scheduled, status: 'skipped', skip_penalty_xp: 10 });
    });

    it('writes the penalty to the ledger against the session', async () => {
      const session = await createSession({ target_duration_minutes: 30 });

      await app.agent.post(`/sessions/${session.id}/skip`);

      const { rows } = await database.client.query<{
        source_type: string;
        final_xp: number;
        virtue_id: string | null;
        description: string;
      }>(
        `select source_type, final_xp, virtue_id, description
           from public.xp_ledger where user_id = $1 and source_id = $2`,
        [user.id, session.id],
      );

      expect(rows).toEqual([
        {
          source_type: 'penalty',
          final_xp: -10,
          virtue_id: null,
          description: 'Skipped session: Deep work',
        },
      ]);
    });

    it('does not count as activity, so a skip cannot sustain a streak', async () => {
      const session = await createSession({ target_duration_minutes: 30 });

      await app.agent.post(`/sessions/${session.id}/skip`);

      const { rows } = await database.client.query<{
        completion_count: number;
        xp_earned: number;
      }>(`select completion_count, xp_earned from public.daily_activity where user_id = $1`, [
        user.id,
      ]);

      expect(rows).toEqual([{ completion_count: 0, xp_earned: -10 }]);
    });

    it('records an instance for a session that has no scheduled slot', async () => {
      const session = await createSession({ target_duration_minutes: 60 });

      const res = await app.agent.post(`/sessions/${session.id}/skip`);

      expect(res.status).toBe(StatusCodes.OK);
      const rows = await instances(session.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'skipped',
        scheduled_at: null,
        // floor(75 * 0.25) = 18.
        skip_penalty_xp: 18,
      });
    });

    it('returns 404 for a session that does not exist', async () => {
      const res = await app.agent.post('/sessions/00000000-0000-0000-0000-000000000000/skip');

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's session", async () =>
      withUser({}, async (otherApp) => {
        const session = await createSession();

        const res = await otherApp.agent.post(`/sessions/${session.id}/skip`);

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
        expect(await instances(session.id)).toHaveLength(0);
      }));

    it('rejects an unauthenticated request', async () => {
      const session = await createSession();

      const res = await app.unauthenticatedAgent.post(`/sessions/${session.id}/skip`);

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });
});
