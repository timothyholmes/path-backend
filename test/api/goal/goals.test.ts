import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StatusCodes } from 'http-status-codes';
import { TempDatabase, createMigratedDatabase, hasDatabase } from '../../db/helpers';
import { seedUser, SeedUserOptions, SeededUser } from '../shared/fixtures';
import { createDbTestApp, DbTestApp } from '../shared/testApp';

interface GoalRow {
  id: string;
  status: string;
  completed_at: Date | null;
  due_date: string | null;
  parent_goal_id: string | null;
}

interface LedgerRow {
  source_type: string;
  source_id: string | null;
  base_xp: number;
  final_xp: number;
  virtue_id: string | null;
  description: string | null;
}

describe.skipIf(!hasDatabase)('goals', () => {
  let database: TempDatabase;
  let user: SeededUser;
  let app: DbTestApp;

  beforeAll(async () => {
    database = await createMigratedDatabase('goals');
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  // Every test gets its own freshly seeded user (and therefore its own empty
  // set of goals and untouched XP totals), so tests never depend on ordering or
  // on what an earlier test left behind.
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

  /** Creates a goal through the API and returns its body, failing loudly if the create didn't. */
  async function createGoal(body: Record<string, unknown> = {}, agent = app.agent) {
    const res = await agent.post('/goals').send({ title: 'Ship the thing', ...body });
    expect(res.status).toBe(StatusCodes.CREATED);
    return res.body;
  }

  async function createBacklogItem(body: Record<string, unknown> = {}, agent = app.agent) {
    const res = await agent.post('/goals/backlog').send({ title: 'An idea', ...body });
    expect(res.status).toBe(StatusCodes.CREATED);
    return res.body;
  }

  async function goalRows(userId = user.id): Promise<GoalRow[]> {
    const { rows } = await database.client.query<GoalRow>(
      `select id, status, completed_at, due_date::text as due_date, parent_goal_id
         from public.goals where user_id = $1 order by created_at`,
      [userId],
    );
    return rows;
  }

  async function ledger(userId = user.id): Promise<LedgerRow[]> {
    const { rows } = await database.client.query<LedgerRow>(
      `select source_type, source_id, base_xp, final_xp, virtue_id, description
         from public.xp_ledger where user_id = $1 order by created_at, virtue_id nulls first`,
      [userId],
    );
    return rows;
  }

  /** Inserts active goals directly, bypassing the API, to set up cap scenarios. */
  async function seedActiveGoals(count: number, userId = user.id) {
    await database.client.query(
      `insert into public.goals (user_id, title, status)
       select $1, 'Seeded ' || g, 'active' from generate_series(1, $2) g`,
      [userId, count],
    );
  }

  /**
   * A user holding `activeGoals` active goals on a lapsed premium subscription.
   * The goals have to be created while the subscription is live: the plan-limit
   * trigger refuses the inserts once it has expired, which is exactly why being
   * over the cap is only reachable this way.
   */
  async function withLapsedPremium<T>(
    activeGoals: number,
    fn: (lapsedApp: DbTestApp, lapsedUser: SeededUser) => Promise<T>,
  ): Promise<T> {
    const future = new Date(Date.now() + 86_400_000);
    return withUser(
      { tier: 'premium', subscriptionExpiresAt: future },
      async (lapsedApp, lapsedUser) => {
        await seedActiveGoals(activeGoals, lapsedUser.id);
        await database.client.query(
          `update public.profiles set subscription_expires_at = now() - interval '1 day'
          where id = $1`,
          [lapsedUser.id],
        );
        return fn(lapsedApp, lapsedUser);
      },
    );
  }

  describe('POST /goals', () => {
    it('creates a goal with the schema defaults', async () => {
      const res = await app.agent.post('/goals').send({ title: 'Ship the thing' });

      expect(res.status).toBe(StatusCodes.CREATED);
      expect(res.body).toMatchObject({
        user_id: user.id,
        title: 'Ship the thing',
        description: null,
        is_quest: false,
        status: 'backlog',
        due_date: null,
        base_xp: 150,
        parent_goal_id: null,
        display_order: 0,
        virtue_ids: [],
        completed_at: null,
      });
      expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('stores every supplied field', async () => {
      const goal = await createGoal({
        title: 'Record an EP',
        description: 'Four songs, mixed and mastered.',
        is_quest: true,
        status: 'active',
        due_date: '2027-03-01',
        base_xp: 750,
        virtue_ids: [user.virtueIds[0], user.virtueIds[1]],
      });

      expect(goal).toMatchObject({
        title: 'Record an EP',
        description: 'Four songs, mixed and mastered.',
        is_quest: true,
        status: 'active',
        due_date: '2027-03-01',
        base_xp: 750,
      });
      expect(goal.virtue_ids).toHaveLength(2);
    });

    // `due_date` is a calendar date. Handing it back through a JS Date would
    // land on the previous day for anyone west of UTC.
    it('round-trips the due date as the calendar date it was given', async () => {
      const goal = await createGoal({ due_date: '2027-01-01' });

      expect(goal.due_date).toBe('2027-01-01');
      expect((await goalRows())[0].due_date).toBe('2027-01-01');
    });

    it('creates a subtask under a parent goal', async () => {
      const parent = await createGoal({ status: 'active' });

      const subtask = await createGoal({ title: 'Write four songs', parent_goal_id: parent.id });

      expect(subtask.parent_goal_id).toBe(parent.id);
    });

    it('stamps completed_at when created already completed', async () => {
      const goal = await createGoal({ status: 'completed' });

      expect(goal.status).toBe('completed');
      expect(goal.completed_at).not.toBeNull();
    });

    it('awards no XP for a goal created as completed', async () => {
      await createGoal({ status: 'completed', virtue_ids: [user.virtueIds[0]] });

      expect(await ledger()).toHaveLength(0);
    });

    it('rejects a virtue that does not exist', async () => {
      const res = await app.agent
        .post('/goals')
        .send({ title: 'Nope', virtue_ids: ['00000000-0000-0000-0000-000000000000'] });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body.message).toMatch(/virtue_ids/);
    });

    it("rejects another user's virtue", async () =>
      withUser({}, async (_otherApp, otherUser) => {
        const res = await app.agent
          .post('/goals')
          .send({ title: 'Nope', virtue_ids: [otherUser.virtueIds[0]] });

        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      }));

    it('rejects duplicate virtue ids', async () => {
      const res = await app.agent
        .post('/goals')
        .send({ title: 'Nope', virtue_ids: [user.virtueIds[0], user.virtueIds[0]] });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body.message).toMatch(/duplicates/);
    });

    it('rejects a parent goal that does not exist', async () => {
      const res = await app.agent
        .post('/goals')
        .send({ title: 'Orphan', parent_goal_id: '00000000-0000-0000-0000-000000000000' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body.message).toMatch(/parent_goal_id/);
    });

    it("rejects another user's goal as a parent", async () =>
      withUser({}, async (otherApp) => {
        const theirs = await createGoal({}, otherApp.agent);

        const res = await app.agent
          .post('/goals')
          .send({ title: 'Orphan', parent_goal_id: theirs.id });

        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      }));

    it('rejects an impossible calendar date', async () => {
      const res = await app.agent.post('/goals').send({ title: 'Nope', due_date: '2027-02-30' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    // `express-openapi-validator` does not enforce request-body schemas against
    // this OpenAPI 3.1 document, so a missing title reaches the NOT NULL column
    // and has to be mapped back to a 400 rather than surfacing as a 500.
    it('requires a title', async () => {
      const res = await app.agent.post('/goals').send({ description: 'No title' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body.message).toMatch(/title is required/);
    });

    it('rejects a status outside the enum', async () => {
      const res = await app.agent.post('/goals').send({ title: 'Nope', status: 'nonsense' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('rejects a title longer than the column allows', async () => {
      const res = await app.agent.post('/goals').send({ title: 'x'.repeat(301) });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('returns 402 for a fourth active goal on the free plan', async () => {
      await seedActiveGoals(3);

      const res = await app.agent.post('/goals').send({ title: 'Fourth', status: 'active' });

      expect(res.status).toBe(StatusCodes.PAYMENT_REQUIRED);
      expect(res.body.message).toMatch(/at most 3 active goals/);
    });

    it('does not count backlog or archived goals toward the cap', async () => {
      await seedActiveGoals(3);

      await createGoal({ title: 'Idea' });
      await createGoal({ title: 'Shelved', status: 'archived' });

      expect(await goalRows()).toHaveLength(5);
    });

    it('lets a premium user past the cap', async () =>
      withUser({ tier: 'premium' }, async (premiumApp, premiumUser) => {
        await seedActiveGoals(3, premiumUser.id);

        const res = await premiumApp.agent
          .post('/goals')
          .send({ title: 'Fourth', status: 'active' });

        expect(res.status).toBe(StatusCodes.CREATED);
      }));

    it('caps a lapsed premium user like a free one', async () =>
      withLapsedPremium(3, async (lapsedApp) => {
        const res = await lapsedApp.agent
          .post('/goals')
          .send({ title: 'Fourth', status: 'active' });

        expect(res.status).toBe(StatusCodes.PAYMENT_REQUIRED);
      }));

    it('requires authentication', async () => {
      const res = await app.unauthenticatedAgent.post('/goals').send({ title: 'Ship the thing' });

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('GET /goals', () => {
    it('returns top-level goals only when no parent is given', async () => {
      const parent = await createGoal({ title: 'Parent', status: 'active' });
      await createGoal({ title: 'Subtask', parent_goal_id: parent.id });

      const res = await app.agent.get('/goals');

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].title).toBe('Parent');
    });

    it('returns the subtasks of a parent goal', async () => {
      const parent = await createGoal({ title: 'Parent', status: 'active' });
      await createGoal({ title: 'First', parent_goal_id: parent.id });
      await createGoal({ title: 'Second', parent_goal_id: parent.id });

      const res = await app.agent.get('/goals').query({ parent_goal_id: parent.id });

      expect(res.body.map((goal: { title: string }) => goal.title).sort()).toEqual([
        'First',
        'Second',
      ]);
    });

    it('filters by status', async () => {
      await createGoal({ title: 'Active', status: 'active' });
      await createGoal({ title: 'Idea' });

      const res = await app.agent.get('/goals').query({ status: 'active' });

      expect(res.body).toHaveLength(1);
      expect(res.body[0].title).toBe('Active');
    });

    it('filters by quest flag', async () => {
      await createGoal({ title: 'Quest', is_quest: true, status: 'active' });
      await createGoal({ title: 'Ordinary', status: 'active' });

      const quests = await app.agent.get('/goals').query({ is_quest: true });
      const ordinary = await app.agent.get('/goals').query({ is_quest: false });

      expect(quests.body.map((goal: { title: string }) => goal.title)).toEqual(['Quest']);
      expect(ordinary.body.map((goal: { title: string }) => goal.title)).toEqual(['Ordinary']);
    });

    it('orders subtasks by display_order', async () => {
      const parent = await createGoal({ title: 'Parent', status: 'active' });
      const first = await createGoal({ title: 'First', parent_goal_id: parent.id });
      const second = await createGoal({ title: 'Second', parent_goal_id: parent.id });
      await app.agent.patch(`/goals/${first.id}`).send({ display_order: 2 });
      await app.agent.patch(`/goals/${second.id}`).send({ display_order: 1 });

      const res = await app.agent.get('/goals').query({ parent_goal_id: parent.id });

      expect(res.body.map((goal: { title: string }) => goal.title)).toEqual(['Second', 'First']);
    });

    it('includes the tagged virtues', async () => {
      await createGoal({ virtue_ids: [user.virtueIds[0], user.virtueIds[1]] });

      const res = await app.agent.get('/goals');

      expect(res.body[0].virtue_ids.sort()).toEqual([user.virtueIds[0], user.virtueIds[1]].sort());
    });

    // The validator lets an out-of-enum filter through to the `goal_status`
    // cast, so the module has to answer it rather than fall over.
    it('rejects a status outside the enum', async () => {
      const res = await app.agent.get('/goals').query({ status: 'nonsense' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('rejects a malformed parent_goal_id', async () => {
      const res = await app.agent.get('/goals').query({ parent_goal_id: 'not-a-uuid' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it("never returns another user's goals", async () =>
      withUser({}, async (otherApp) => {
        await createGoal({ title: 'Mine' });
        await createGoal({ title: 'Theirs' }, otherApp.agent);

        const res = await app.agent.get('/goals');

        expect(res.body).toHaveLength(1);
        expect(res.body[0].title).toBe('Mine');
      }));

    it('requires authentication', async () => {
      const res = await app.unauthenticatedAgent.get('/goals');

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('PATCH /goals/{id}', () => {
    it('changes only the fields supplied', async () => {
      const goal = await createGoal({
        description: 'Original',
        base_xp: 200,
        virtue_ids: [user.virtueIds[0]],
      });

      const res = await app.agent.patch(`/goals/${goal.id}`).send({ title: 'Renamed' });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toMatchObject({
        title: 'Renamed',
        description: 'Original',
        base_xp: 200,
        virtue_ids: [user.virtueIds[0]],
      });
    });

    it('changes the description and the quest flag', async () => {
      const goal = await createGoal({ description: 'Original' });

      const res = await app.agent
        .patch(`/goals/${goal.id}`)
        .send({ description: 'Rewritten', is_quest: true });

      expect(res.body).toMatchObject({ description: 'Rewritten', is_quest: true });
    });

    it('replaces the tagged virtues', async () => {
      const goal = await createGoal({ virtue_ids: [user.virtueIds[0]] });

      const res = await app.agent
        .patch(`/goals/${goal.id}`)
        .send({ virtue_ids: [user.virtueIds[1]] });

      expect(res.body.virtue_ids).toEqual([user.virtueIds[1]]);
    });

    it('clears the due date with an explicit null', async () => {
      const goal = await createGoal({ due_date: '2027-03-01' });

      const res = await app.agent.patch(`/goals/${goal.id}`).send({ due_date: null });

      expect(res.body.due_date).toBeNull();
    });

    it('returns the goal unchanged for an empty patch', async () => {
      const goal = await createGoal({ virtue_ids: [user.virtueIds[0]] });

      const res = await app.agent.patch(`/goals/${goal.id}`).send({});

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toMatchObject({ title: goal.title, virtue_ids: [user.virtueIds[0]] });
    });

    // `goals_completed_at_matches_status` requires the two to agree, and
    // GoalUpdate has no completed_at for the caller to send.
    it('stamps completed_at when the status becomes completed', async () => {
      const goal = await createGoal({ status: 'active' });

      const res = await app.agent.patch(`/goals/${goal.id}`).send({ status: 'completed' });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body.completed_at).not.toBeNull();
    });

    it('clears completed_at when the status leaves completed', async () => {
      const goal = await createGoal({ status: 'completed' });

      const res = await app.agent.patch(`/goals/${goal.id}`).send({ status: 'active' });

      expect(res.body.status).toBe('active');
      expect(res.body.completed_at).toBeNull();
    });

    it('does not move completed_at when the status is re-sent', async () => {
      const goal = await createGoal({ status: 'completed' });

      const res = await app.agent.patch(`/goals/${goal.id}`).send({ status: 'completed' });

      expect(res.body.completed_at).toBe(goal.completed_at);
    });

    it('awards no XP for completing through a status change', async () => {
      const goal = await createGoal({ status: 'active', virtue_ids: [user.virtueIds[0]] });

      await app.agent.patch(`/goals/${goal.id}`).send({ status: 'completed' });

      expect(await ledger()).toHaveLength(0);
    });

    it('returns 402 when activating a goal past the free-tier cap', async () => {
      await seedActiveGoals(3);
      const goal = await createGoal({ title: 'Idea' });

      const res = await app.agent.patch(`/goals/${goal.id}`).send({ status: 'active' });

      expect(res.status).toBe(StatusCodes.PAYMENT_REQUIRED);
      expect((await goalRows()).find((row) => row.id === goal.id)?.status).toBe('backlog');
    });

    it('returns 404 for a goal that does not exist', async () => {
      const res = await app.agent
        .patch('/goals/00000000-0000-0000-0000-000000000000')
        .send({ title: 'Nope' });

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's goal", async () =>
      withUser({}, async (otherApp) => {
        const theirs = await createGoal({}, otherApp.agent);

        const res = await app.agent.patch(`/goals/${theirs.id}`).send({ title: 'Mine now' });

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
      }));

    it('requires authentication', async () => {
      const goal = await createGoal();

      const res = await app.unauthenticatedAgent
        .patch(`/goals/${goal.id}`)
        .send({ title: 'Renamed' });

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('DELETE /goals/{id}', () => {
    it('deletes the goal, its subtasks, and its virtue tags', async () => {
      const parent = await createGoal({ status: 'active', virtue_ids: [user.virtueIds[0]] });
      await createGoal({ title: 'Subtask', parent_goal_id: parent.id });

      const res = await app.agent.delete(`/goals/${parent.id}`);

      expect(res.status).toBe(StatusCodes.NO_CONTENT);
      expect(await goalRows()).toHaveLength(0);
      const { rows } = await database.client.query(
        `select 1 from public.goal_virtues where user_id = $1`,
        [user.id],
      );
      expect(rows).toHaveLength(0);
    });

    it('leaves a promoted backlog item behind, promotable again', async () => {
      const item = await createBacklogItem();
      const promoted = await app.agent.post(`/goals/backlog/${item.id}/promote`);

      await app.agent.delete(`/goals/${promoted.body.id}`);

      const res = await app.agent.get('/goals/backlog');
      expect(res.body).toHaveLength(1);
      expect(res.body[0].promoted_to_goal_id).toBeNull();
    });

    it('returns 404 for a goal that does not exist', async () => {
      const res = await app.agent.delete('/goals/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's goal", async () =>
      withUser({}, async (otherApp) => {
        const theirs = await createGoal({}, otherApp.agent);

        const res = await app.agent.delete(`/goals/${theirs.id}`);

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
        expect(await goalRows(theirs.user_id)).toHaveLength(1);
      }));

    it('requires authentication', async () => {
      const goal = await createGoal();

      const res = await app.unauthenticatedAgent.delete(`/goals/${goal.id}`);

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('POST /goals/{id}/complete', () => {
    it('marks the goal completed and awards its base XP', async () => {
      const goal = await createGoal({ status: 'active', virtue_ids: [user.virtueIds[0]] });

      const res = await app.agent.post(`/goals/${goal.id}/complete`);

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toMatchObject({
        base_xp: 150,
        streak_multiplier: 1,
        xp_earned: 150,
        global_xp: 150,
      });

      const [row] = await goalRows();
      expect(row.status).toBe('completed');
      expect(row.completed_at).not.toBeNull();
    });

    it('writes a goal ledger row against the goal itself', async () => {
      const goal = await createGoal({
        title: 'Run a 5k',
        status: 'active',
        virtue_ids: [user.virtueIds[0]],
      });

      await app.agent.post(`/goals/${goal.id}/complete`);

      expect(await ledger()).toMatchObject([
        {
          source_type: 'goal',
          source_id: goal.id,
          base_xp: 150,
          virtue_id: user.virtueIds[0],
          description: 'Goal completed: Run a 5k',
        },
      ]);
    });

    it('awards a quest a bonus over a standard goal', async () => {
      const quest = await createGoal({
        title: 'Record an EP',
        is_quest: true,
        status: 'active',
        virtue_ids: [user.virtueIds[0]],
      });

      const res = await app.agent.post(`/goals/${quest.id}/complete`);

      // floor(150 * 1.5) = 225.
      expect(res.body).toMatchObject({ base_xp: 225, xp_earned: 225 });
      expect((await ledger())[0].description).toBe('Quest completed: Record an EP');
    });

    it('applies the multi-virtue bonus', async () => {
      const goal = await createGoal({
        status: 'active',
        virtue_ids: [user.virtueIds[0], user.virtueIds[1]],
      });

      const res = await app.agent.post(`/goals/${goal.id}/complete`);

      expect(res.body.virtue_bonus).toBeCloseTo(1.1);
      expect(res.body.xp_earned).toBe(165);
      expect(res.body.ledger_entry_ids).toHaveLength(2);
    });

    it('scores an untagged goal globally, with no virtue row', async () => {
      const goal = await createGoal({ status: 'active' });

      const res = await app.agent.post(`/goals/${goal.id}/complete`);

      expect(res.status).toBe(StatusCodes.OK);
      expect(await ledger()).toMatchObject([{ source_id: goal.id, virtue_id: null }]);
    });

    // Subtask XP belongs to the goal it serves: the ledger points at the parent
    // and, untagged, inherits the parent's virtues (db/seed/scenarios).
    it('credits a completed subtask to its parent goal', async () => {
      const parent = await createGoal({
        title: 'Learn Spanish',
        status: 'active',
        virtue_ids: [user.virtueIds[1]],
      });
      const subtask = await createGoal({
        title: 'Finish unit 3',
        base_xp: 50,
        parent_goal_id: parent.id,
      });

      const res = await app.agent.post(`/goals/${subtask.id}/complete`);

      expect(res.body).toMatchObject({ base_xp: 50, xp_earned: 50 });
      expect(await ledger()).toMatchObject([
        {
          source_type: 'goal',
          source_id: parent.id,
          virtue_id: user.virtueIds[1],
          description: 'Subtask completed: Finish unit 3',
        },
      ]);
      expect((await goalRows()).find((row) => row.id === parent.id)?.status).toBe('active');
    });

    it("prefers a subtask's own virtues over its parent's", async () => {
      const parent = await createGoal({
        status: 'active',
        virtue_ids: [user.virtueIds[1]],
      });
      const subtask = await createGoal({
        title: 'Tagged subtask',
        parent_goal_id: parent.id,
        virtue_ids: [user.virtueIds[2]],
      });

      await app.agent.post(`/goals/${subtask.id}/complete`);

      expect((await ledger())[0].virtue_id).toBe(user.virtueIds[2]);
    });

    it('returns 409 for a goal that is already completed', async () => {
      const goal = await createGoal({ status: 'active' });
      await app.agent.post(`/goals/${goal.id}/complete`);

      const res = await app.agent.post(`/goals/${goal.id}/complete`);

      expect(res.status).toBe(StatusCodes.CONFLICT);
      expect(await ledger()).toHaveLength(1);
    });

    it('returns 409 for a goal completed through a status change', async () => {
      const goal = await createGoal({ status: 'completed' });

      const res = await app.agent.post(`/goals/${goal.id}/complete`);

      expect(res.status).toBe(StatusCodes.CONFLICT);
    });

    it('frees a slot under the free-tier cap', async () => {
      await seedActiveGoals(2);
      const goal = await createGoal({ status: 'active' });

      await app.agent.post(`/goals/${goal.id}/complete`);
      const res = await app.agent.post('/goals').send({ title: 'Replacement', status: 'active' });

      expect(res.status).toBe(StatusCodes.CREATED);
    });

    // The cap is re-checked on every write to a goal, so a user who is already
    // over it cannot complete one until they are back under.
    it('returns 402 for a user already over the cap', async () =>
      withLapsedPremium(5, async (lapsedApp, lapsedUser) => {
        const [target] = await goalRows(lapsedUser.id);

        const res = await lapsedApp.agent.post(`/goals/${target.id}/complete`);

        expect(res.status).toBe(StatusCodes.PAYMENT_REQUIRED);
        expect(await ledger(lapsedUser.id)).toHaveLength(0);
      }));

    it('returns 404 for a goal that does not exist', async () => {
      const res = await app.agent.post('/goals/00000000-0000-0000-0000-000000000000/complete');

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's goal", async () =>
      withUser({}, async (otherApp) => {
        const theirs = await createGoal({ status: 'active' }, otherApp.agent);

        const res = await app.agent.post(`/goals/${theirs.id}/complete`);

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
      }));

    it('requires authentication', async () => {
      const goal = await createGoal({ status: 'active' });

      const res = await app.unauthenticatedAgent.post(`/goals/${goal.id}/complete`);

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('POST /goals/backlog', () => {
    it('creates a manual idea by default', async () => {
      const res = await app.agent.post('/goals/backlog').send({ title: 'Try cold showers' });

      expect(res.status).toBe(StatusCodes.CREATED);
      expect(res.body).toMatchObject({
        user_id: user.id,
        title: 'Try cold showers',
        notes: null,
        source: 'manual',
        source_id: null,
        virtue_id: null,
        promoted_to_goal_id: null,
      });
    });

    it('stores notes, a virtue, and an originating row', async () => {
      const sourceId = '11111111-1111-4111-8111-111111111111';

      const item = await createBacklogItem({
        title: 'Run a weekly service block',
        notes: 'Suggested during the retro.',
        source: 'ai_suggestion',
        source_id: sourceId,
        virtue_id: user.virtueIds[3],
      });

      expect(item).toMatchObject({
        notes: 'Suggested during the retro.',
        source: 'ai_suggestion',
        source_id: sourceId,
        virtue_id: user.virtueIds[3],
      });
    });

    // source_id names a field log or retrospective, so it is meaningless on an
    // idea the user typed in themselves — and, not being a foreign key, nothing
    // else would catch it.
    it('rejects a source_id on a manual idea', async () => {
      const res = await app.agent.post('/goals/backlog').send({
        title: 'Typed by hand',
        source_id: '11111111-1111-4111-8111-111111111111',
      });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body.message).toMatch(/source_id/);
    });

    it('rejects a virtue that does not exist', async () => {
      const res = await app.agent
        .post('/goals/backlog')
        .send({ title: 'Nope', virtue_id: '00000000-0000-0000-0000-000000000000' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body.message).toMatch(/virtue_id/);
    });

    it('requires a title', async () => {
      const res = await app.agent.post('/goals/backlog').send({ notes: 'No title' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body.message).toMatch(/title is required/);
    });

    it('requires authentication', async () => {
      const res = await app.unauthenticatedAgent.post('/goals/backlog').send({ title: 'Idea' });

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('GET /goals/backlog', () => {
    it('lists unpromoted ideas, newest first', async () => {
      await createBacklogItem({ title: 'First' });
      await createBacklogItem({ title: 'Second' });

      const res = await app.agent.get('/goals/backlog');

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body.map((item: { title: string }) => item.title)).toEqual(['Second', 'First']);
    });

    it('omits items that have been promoted', async () => {
      const item = await createBacklogItem({ title: 'Promoted' });
      await createBacklogItem({ title: 'Still an idea' });
      await app.agent.post(`/goals/backlog/${item.id}/promote`);

      const res = await app.agent.get('/goals/backlog');

      expect(res.body.map((entry: { title: string }) => entry.title)).toEqual(['Still an idea']);
    });

    it("never returns another user's ideas", async () =>
      withUser({}, async (otherApp) => {
        await createBacklogItem({ title: 'Theirs' }, otherApp.agent);

        const res = await app.agent.get('/goals/backlog');

        expect(res.body).toHaveLength(0);
      }));

    it('requires authentication', async () => {
      const res = await app.unauthenticatedAgent.get('/goals/backlog');

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('PATCH /goals/backlog/{id}', () => {
    it('edits the title, notes, and virtue', async () => {
      const item = await createBacklogItem();

      const res = await app.agent.patch(`/goals/backlog/${item.id}`).send({
        title: 'Re-read Meditations',
        notes: 'Slowly this time.',
        virtue_id: user.virtueIds[3],
      });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toMatchObject({
        title: 'Re-read Meditations',
        notes: 'Slowly this time.',
        virtue_id: user.virtueIds[3],
      });
    });

    it('clears notes and virtue with an explicit null', async () => {
      const item = await createBacklogItem({ notes: 'Some notes', virtue_id: user.virtueIds[0] });

      const res = await app.agent
        .patch(`/goals/backlog/${item.id}`)
        .send({ notes: null, virtue_id: null });

      expect(res.body).toMatchObject({ notes: null, virtue_id: null });
    });

    it('returns the item unchanged for an empty patch', async () => {
      const item = await createBacklogItem({ notes: 'Some notes' });

      const res = await app.agent.patch(`/goals/backlog/${item.id}`).send({});

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toMatchObject({ title: item.title, notes: 'Some notes' });
    });

    // api-spec.yml sends the caller to PATCH /goals/{id} once an idea has
    // become a goal, and gives this operation no 409 to refuse with.
    it('refuses to edit an item that has been promoted', async () => {
      const item = await createBacklogItem();
      await app.agent.post(`/goals/backlog/${item.id}/promote`);

      const res = await app.agent.patch(`/goals/backlog/${item.id}`).send({ title: 'Too late' });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body.message).toMatch(/already promoted/);
    });

    it('returns 404 for an item that does not exist', async () => {
      const res = await app.agent
        .patch('/goals/backlog/00000000-0000-0000-0000-000000000000')
        .send({ title: 'Nope' });

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's item", async () =>
      withUser({}, async (otherApp) => {
        const theirs = await createBacklogItem({}, otherApp.agent);

        const res = await app.agent.patch(`/goals/backlog/${theirs.id}`).send({ title: 'Mine' });

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
      }));

    it('requires authentication', async () => {
      const item = await createBacklogItem();

      const res = await app.unauthenticatedAgent
        .patch(`/goals/backlog/${item.id}`)
        .send({ title: 'Nope' });

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('DELETE /goals/backlog/{id}', () => {
    it('removes the idea', async () => {
      const item = await createBacklogItem();

      const res = await app.agent.delete(`/goals/backlog/${item.id}`);

      expect(res.status).toBe(StatusCodes.NO_CONTENT);
      expect((await app.agent.get('/goals/backlog')).body).toHaveLength(0);
    });

    it('leaves the goal a promoted item became', async () => {
      const item = await createBacklogItem();
      const promoted = await app.agent.post(`/goals/backlog/${item.id}/promote`);

      await app.agent.delete(`/goals/backlog/${item.id}`);

      expect((await goalRows()).map((row) => row.id)).toEqual([promoted.body.id]);
    });

    it('returns 404 for an item that does not exist', async () => {
      const res = await app.agent.delete('/goals/backlog/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's item", async () =>
      withUser({}, async (otherApp) => {
        const theirs = await createBacklogItem({}, otherApp.agent);

        const res = await app.agent.delete(`/goals/backlog/${theirs.id}`);

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
      }));

    it('requires authentication', async () => {
      const item = await createBacklogItem();

      const res = await app.unauthenticatedAgent.delete(`/goals/backlog/${item.id}`);

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });

  describe('POST /goals/backlog/{id}/promote', () => {
    it('creates an active goal from the idea and stamps the item', async () => {
      const item = await createBacklogItem({
        title: 'Run a weekly service block',
        notes: 'Suggested during the retro.',
        virtue_id: user.virtueIds[0],
      });

      const res = await app.agent.post(`/goals/backlog/${item.id}/promote`);

      expect(res.status).toBe(StatusCodes.CREATED);
      expect(res.body).toMatchObject({
        title: 'Run a weekly service block',
        description: 'Suggested during the retro.',
        status: 'active',
        is_quest: false,
        base_xp: 150,
        virtue_ids: [user.virtueIds[0]],
      });

      const { rows } = await database.client.query<{ promoted_to_goal_id: string }>(
        `select promoted_to_goal_id from public.goal_backlog where id = $1`,
        [item.id],
      );
      expect(rows[0].promoted_to_goal_id).toBe(res.body.id);
    });

    it('applies the supplied overrides', async () => {
      const item = await createBacklogItem();

      const res = await app.agent
        .post(`/goals/backlog/${item.id}/promote`)
        .send({ is_quest: true, due_date: '2027-06-30', base_xp: 750 });

      expect(res.body).toMatchObject({
        is_quest: true,
        due_date: '2027-06-30',
        base_xp: 750,
      });
    });

    it('promotes an idea with no notes or virtue', async () => {
      const item = await createBacklogItem();

      const res = await app.agent.post(`/goals/backlog/${item.id}/promote`);

      expect(res.body).toMatchObject({ description: null, virtue_ids: [] });
    });

    it('returns 409 when the item was already promoted', async () => {
      const item = await createBacklogItem();
      await app.agent.post(`/goals/backlog/${item.id}/promote`);

      const res = await app.agent.post(`/goals/backlog/${item.id}/promote`);

      expect(res.status).toBe(StatusCodes.CONFLICT);
      expect(await goalRows()).toHaveLength(1);
    });

    // Driven through storage rather than HTTP: over the wire the two requests
    // stagger and the race never appears, so an equivalent supertest version
    // would pass even with the row lock removed.
    it('serialises concurrent promotions into a single goal', async () => {
      const item = await createBacklogItem();
      const storage = app.dependencies.goalStorage;

      const results = await Promise.allSettled([
        storage.promoteBacklogItem(user.id, item.id, {}),
        storage.promoteBacklogItem(user.id, item.id, {}),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await goalRows()).toHaveLength(1);
    });

    it('returns 402 when the free-tier cap is already reached', async () => {
      await seedActiveGoals(3);
      const item = await createBacklogItem();

      const res = await app.agent.post(`/goals/backlog/${item.id}/promote`);

      expect(res.status).toBe(StatusCodes.PAYMENT_REQUIRED);
      expect((await app.agent.get('/goals/backlog')).body).toHaveLength(1);
    });

    it('returns 404 for an item that does not exist', async () => {
      const res = await app.agent.post(
        '/goals/backlog/00000000-0000-0000-0000-000000000000/promote',
      );

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it("returns 404 for another user's item", async () =>
      withUser({}, async (otherApp) => {
        const theirs = await createBacklogItem({}, otherApp.agent);

        const res = await app.agent.post(`/goals/backlog/${theirs.id}/promote`);

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
      }));

    it('requires authentication', async () => {
      const item = await createBacklogItem();

      const res = await app.unauthenticatedAgent.post(`/goals/backlog/${item.id}/promote`);

      expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    });
  });
});
