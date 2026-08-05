import { addDays } from '../rng';
import { HistoricalRoutine, simulateRoutineHistory } from '../history';
import { Scenario } from '../types';

const TIMEZONE = 'America/Chicago';
const HISTORY_DAYS = 14;

/**
 * A free user sitting exactly on every plan limit: 4 virtues, 10 active
 * routines, 3 active goals. This is the shape that catches off-by-one errors in
 * the cap triggers -- anything that miscounts by one either rejects this
 * scenario outright or lets an eleventh routine through.
 */
export const activeFree: Scenario = {
  name: 'active-free',
  description: 'Free user at all plan caps with two weeks of routine history and a live streak.',
  async run({ seeder, rng, asOf }) {
    await seeder.ensureLedgerPartitions(2);

    const user = await seeder.addUser({
      key: 'active-free',
      email: 'free@path.test',
      displayName: 'Frank Free',
      timezone: TIMEZONE,
      tier: 'free',
    });

    // Exactly the four the signup trigger created: the free cap.
    const virtues = await seeder.virtueIds(user.id);
    const [body, mind, craft, spirit] = virtues;

    const definitions: Array<{
      key: string;
      title: string;
      frequency: 'daily' | 'weekly' | 'monthly';
      scheduledDay: number | null;
      virtueIds: string[];
    }> = [
      {
        key: 'free-stretch',
        title: 'Morning stretch',
        frequency: 'daily',
        scheduledDay: null,
        virtueIds: [body],
      },
      {
        key: 'free-read',
        title: 'Read 20 pages',
        frequency: 'daily',
        scheduledDay: null,
        virtueIds: [mind],
      },
      {
        key: 'free-journal',
        title: 'Journal',
        frequency: 'daily',
        scheduledDay: null,
        virtueIds: [spirit],
      },
      {
        key: 'free-practice',
        title: 'Practice guitar',
        frequency: 'daily',
        scheduledDay: null,
        virtueIds: [craft],
      },
      {
        key: 'free-walk',
        title: 'Walk outside',
        frequency: 'daily',
        scheduledDay: null,
        virtueIds: [body, spirit],
      },
      {
        key: 'free-tidy',
        title: 'Tidy desk',
        frequency: 'daily',
        scheduledDay: null,
        virtueIds: [craft],
      },
      {
        key: 'free-longrun',
        title: 'Long run',
        frequency: 'weekly',
        scheduledDay: 6,
        virtueIds: [body],
      },
      {
        key: 'free-review',
        title: 'Weekly review',
        frequency: 'weekly',
        scheduledDay: 0,
        virtueIds: [mind, spirit],
      },
      {
        key: 'free-call',
        title: 'Call family',
        frequency: 'weekly',
        scheduledDay: 3,
        virtueIds: [spirit],
      },
      {
        key: 'free-budget',
        title: 'Budget review',
        frequency: 'monthly',
        scheduledDay: 1,
        virtueIds: [mind, craft],
      },
    ];

    const routines: HistoricalRoutine[] = [];

    for (const definition of definitions) {
      const id = await seeder.addRoutine({
        key: definition.key,
        userId: user.id,
        title: definition.title,
        frequency: definition.frequency,
        scheduledDay: definition.scheduledDay,
        virtueIds: definition.virtueIds,
        createdAt: addDays(asOf, -HISTORY_DAYS - 1),
      });

      const baseXp =
        definition.frequency === 'daily' ? 10 : definition.frequency === 'weekly' ? 25 : 50;

      routines.push({
        id,
        baseXp,
        virtueIds: definition.virtueIds,
        frequency: definition.frequency,
        scheduledDay: definition.scheduledDay,
      });
    }

    // Three active goals, again exactly at the cap, plus a completed one and an
    // archived one that must not count toward it.
    await seeder.addGoal({
      key: 'free-goal-5k',
      userId: user.id,
      title: 'Run a 5k without stopping',
      status: 'active',
      isQuest: true,
      baseXp: 400,
      dueDate: addDays(asOf, 30),
      virtueIds: [body],
      createdAt: addDays(asOf, -HISTORY_DAYS),
    });

    const learnSpanish = await seeder.addGoal({
      key: 'free-goal-spanish',
      userId: user.id,
      title: 'Hold a 10-minute Spanish conversation',
      status: 'active',
      baseXp: 350,
      virtueIds: [mind],
      createdAt: addDays(asOf, -HISTORY_DAYS),
    });

    await seeder.addGoal({
      key: 'free-goal-shelf',
      userId: user.id,
      title: 'Build a bookshelf',
      status: 'active',
      baseXp: 300,
      virtueIds: [craft],
      createdAt: addDays(asOf, -10),
    });

    // Subtasks hang off an active goal and are themselves goals.
    await seeder.addGoal({
      key: 'free-goal-spanish-1',
      userId: user.id,
      title: 'Finish unit 3',
      status: 'completed',
      baseXp: 50,
      parentGoalId: learnSpanish,
      displayOrder: 0,
      completedAt: addDays(asOf, -6),
      createdAt: addDays(asOf, -12),
    });

    await seeder.addGoal({
      key: 'free-goal-spanish-2',
      userId: user.id,
      title: 'Book a tutor session',
      status: 'backlog',
      baseXp: 60,
      parentGoalId: learnSpanish,
      displayOrder: 1,
      createdAt: addDays(asOf, -12),
    });

    await seeder.addGoal({
      key: 'free-goal-archived',
      userId: user.id,
      title: 'Learn to juggle',
      status: 'archived',
      baseXp: 200,
      createdAt: addDays(asOf, -13),
    });

    await seeder.addBacklogItem({
      key: 'free-backlog-1',
      userId: user.id,
      title: 'Try cold showers for a month',
      virtueId: body,
      createdAt: addDays(asOf, -4),
    });

    await seeder.addBacklogItem({
      key: 'free-backlog-2',
      userId: user.id,
      title: 'Re-read Meditations',
      notes: 'Slowly this time.',
      virtueId: spirit,
      createdAt: addDays(asOf, -2),
    });

    // Free tier gets basic text logs only: no template, no AI analysis.
    for (let index = 0; index < 5; index++) {
      await seeder.addFieldLog({
        key: `free-log-${index}`,
        userId: user.id,
        content: { text: `Day ${index + 1}: showed up even though I did not feel like it.` },
        createdAt: addDays(asOf, -(index * 3 + 1)),
      });
    }

    const history = await simulateRoutineHistory({
      seeder,
      rng,
      userId: user.id,
      asOf,
      days: HISTORY_DAYS,
      routines,
      adherence: 0.75,
    });

    // Completing the subtask above earned XP; record it so the ledger explains
    // the profile totals.
    await seeder.addLedgerEntry({
      userId: user.id,
      virtueIds: [mind],
      sourceType: 'goal',
      sourceId: learnSpanish,
      baseXp: 50,
      multiplier: 1.0,
      createdAt: addDays(asOf, -6),
      description: 'Subtask completed: Finish unit 3',
    });

    await seeder.finalize(user.id);

    if (history.completions === 0) {
      throw new Error('active-free produced no completions; adherence or history length is wrong');
    }

    return [user];
  },
};
