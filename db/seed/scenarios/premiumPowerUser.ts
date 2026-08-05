import { addDays, atHour } from '../rng';
import {
  HistoricalRoutine,
  simulateRoutineHistory,
  streakMultiplier,
  virtueBonus,
} from '../history';
import { Scenario } from '../types';

const TIMEZONE = 'America/New_York';
const HISTORY_DAYS = 90;

/**
 * Days back from asOf that are forced idle. The most recent one is at offset 26,
 * so the live streak runs 26 days and the multiplier sits on its 2.0 cap -- the
 * state that only appears after three weeks of real use and is therefore the
 * easiest to never test.
 */
const IDLE_DAYS = [88, 71, 52, 26];

const VICE_TEMPLATE = {
  prompts: [
    { id: 'trigger', type: 'text', label: 'What triggered this?' },
    { id: 'severity', type: 'scale', label: 'Severity', min: 1, max: 10 },
    { id: 'response', type: 'textarea', label: 'How did you respond?' },
    { id: 'lesson', type: 'text', label: 'What will you do differently?' },
  ],
  ai_prompt: 'Analyze this vice log entry. Identify patterns across recent entries.',
};

const GRATITUDE_TEMPLATE = {
  prompts: [
    { id: 'what', type: 'text', label: 'What are you grateful for?' },
    { id: 'why', type: 'textarea', label: 'Why does it matter today?' },
  ],
  ai_prompt: 'Summarise the themes in this gratitude entry.',
};

/**
 * The full-fat scenario: three months of history across every feature, a maxed
 * streak, sessions with partial credit and skips, templated field logs with AI
 * analysis, and both retrospective cadences. Ledger rows span four monthly
 * partitions, which is the only way the partition routing gets exercised.
 */
export const premiumPowerUser: Scenario = {
  name: 'premium-power-user',
  description:
    'Premium user with 90 days of history, streak at the 2.0 cap, sessions, templated field logs, and retrospectives.',
  async run({ client, seeder, rng, asOf }) {
    await seeder.ensureLedgerPartitions(6);

    const user = await seeder.addUser({
      key: 'premium-power',
      email: 'premium@path.test',
      displayName: 'Priya Premium',
      timezone: TIMEZONE,
      tier: 'premium',
      subscriptionExpiresAt: addDays(asOf, 240),
    });

    const defaults = await seeder.virtueIds(user.id);
    const [body, mind, craft, spirit] = defaults;

    // Premium removes the four-virtue cap.
    const lore = await seeder.addVirtue({
      key: 'premium-lore',
      userId: user.id,
      name: 'Lore',
      icon: 'scroll',
      color: '#2E8B57',
      displayOrder: 4,
    });
    const service = await seeder.addVirtue({
      key: 'premium-service',
      userId: user.id,
      name: 'Service',
      icon: 'hands.sparkles',
      color: '#C2185B',
      displayOrder: 5,
    });

    const definitions: Array<{
      key: string;
      title: string;
      frequency: 'daily' | 'weekly' | 'monthly';
      scheduledDay: number | null;
      virtueIds: string[];
    }> = [
      {
        key: 'pp-meditate',
        title: 'Meditate 15 min',
        frequency: 'daily',
        scheduledDay: null,
        virtueIds: [spirit],
      },
      {
        key: 'pp-lift',
        title: 'Strength training',
        frequency: 'daily',
        scheduledDay: null,
        virtueIds: [body],
      },
      {
        key: 'pp-read',
        title: 'Read',
        frequency: 'daily',
        scheduledDay: null,
        virtueIds: [mind, lore],
      },
      {
        key: 'pp-write',
        title: 'Write 500 words',
        frequency: 'daily',
        scheduledDay: null,
        virtueIds: [craft, mind],
      },
      {
        key: 'pp-language',
        title: 'Bulgarian drills',
        frequency: 'daily',
        scheduledDay: null,
        virtueIds: [mind, lore],
      },
      {
        key: 'pp-cold',
        title: 'Cold shower',
        frequency: 'daily',
        scheduledDay: null,
        virtueIds: [body, spirit],
      },
      {
        key: 'pp-inbox',
        title: 'Inbox to zero',
        frequency: 'daily',
        scheduledDay: null,
        virtueIds: [craft],
      },
      {
        key: 'pp-gratitude',
        title: 'Gratitude note',
        frequency: 'daily',
        scheduledDay: null,
        virtueIds: [spirit, service],
      },
      {
        key: 'pp-longrun',
        title: 'Long run',
        frequency: 'weekly',
        scheduledDay: 6,
        virtueIds: [body],
      },
      {
        key: 'pp-review',
        title: 'Weekly review',
        frequency: 'weekly',
        scheduledDay: 0,
        virtueIds: [mind, spirit],
      },
      {
        key: 'pp-volunteer',
        title: 'Volunteer shift',
        frequency: 'weekly',
        scheduledDay: 2,
        virtueIds: [service],
      },
      {
        key: 'pp-finances',
        title: 'Financial review',
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

      routines.push({
        id,
        baseXp: definition.frequency === 'daily' ? 10 : definition.frequency === 'weekly' ? 25 : 50,
        virtueIds: definition.virtueIds,
        frequency: definition.frequency,
        scheduledDay: definition.scheduledDay,
      });
    }

    const history = await simulateRoutineHistory({
      seeder,
      rng,
      userId: user.id,
      asOf,
      days: HISTORY_DAYS,
      routines,
      adherence: 0.85,
      skipDays: IDLE_DAYS,
    });

    // ---------------------------------------------------------------- sessions
    const sessionDefs = [
      {
        key: 'pp-deepwork',
        title: 'Deep work',
        minutes: 90,
        baseXp: 100,
        virtueIds: [craft, mind],
      },
      { key: 'pp-jam', title: 'Jam session', minutes: 60, baseXp: 75, virtueIds: [craft] },
      {
        key: 'pp-lesson',
        title: 'Bulgarian lesson',
        minutes: 30,
        baseXp: 40,
        virtueIds: [mind, lore],
      },
    ];

    const sessions = [];
    for (const definition of sessionDefs) {
      const id = await seeder.addSession({
        key: definition.key,
        userId: user.id,
        title: definition.title,
        targetDurationMinutes: definition.minutes,
        virtueIds: definition.virtueIds,
        recurrenceRule: { freq: 'WEEKLY', byday: ['MO', 'WE', 'FR'] },
        createdAt: addDays(asOf, -HISTORY_DAYS),
      });
      sessions.push({ ...definition, id });
    }

    // 30 days of session instances: mostly completed in full, some ended early
    // for partial credit, some skipped for a penalty.
    for (let offset = 29; offset >= 1; offset--) {
      const day = addDays(asOf, -offset);
      if (day.getUTCDay() === 0) continue;

      const definition = sessions[offset % sessions.length];
      const scheduledAt = atHour(day, 9);
      const targetSeconds = definition.minutes * 60;
      const roll = rng.next();
      const multiplier = streakMultiplier(Math.min(offset < 26 ? 26 - offset : 1, 20));
      const combined = multiplier * virtueBonus(definition.virtueIds.length);

      if (roll < 0.12) {
        const penalty = -Math.floor(definition.baseXp * 0.25);

        await seeder.addSessionInstance({
          key: `pp-inst-${offset}`,
          sessionId: definition.id,
          userId: user.id,
          scheduledAt,
          status: 'skipped',
          skipPenaltyXp: Math.abs(penalty),
        });

        // Penalties are logged at multiplier 1.0: a long streak should not
        // amplify what the user lost.
        await seeder.addLedgerEntry({
          userId: user.id,
          virtueIds: [],
          sourceType: 'penalty',
          sourceId: definition.id,
          baseXp: penalty,
          multiplier: 1.0,
          createdAt: scheduledAt,
          description: `Skipped session: ${definition.title}`,
        });
        continue;
      }

      const partial = roll < 0.32;
      const actualSeconds = partial ? Math.floor(targetSeconds * rng.next() * 0.8) : targetSeconds;
      const startedAt = atHour(day, 9, rng.int(0, 10));
      const endedAt = new Date(startedAt.getTime() + actualSeconds * 1000);
      const proportion = actualSeconds / targetSeconds;
      const awardedBase = Math.floor(definition.baseXp * proportion);

      await seeder.addSessionInstance({
        key: `pp-inst-${offset}`,
        sessionId: definition.id,
        userId: user.id,
        scheduledAt,
        status: 'completed',
        startedAt,
        endedAt,
        actualDurationSeconds: actualSeconds,
        xpEarned: Math.floor(awardedBase * combined),
        focusModeActivated: rng.bool(0.6),
      });

      if (awardedBase > 0) {
        await seeder.addLedgerEntry({
          userId: user.id,
          virtueIds: definition.virtueIds,
          sourceType: 'session',
          sourceId: definition.id,
          baseXp: awardedBase,
          multiplier: combined,
          createdAt: endedAt,
          description: partial
            ? `Partial session: ${definition.title}`
            : `Session completed: ${definition.title}`,
        });
      }
    }

    // ------------------------------------------------------------- field logs
    const viceTemplate = await seeder.addFieldLogTemplate({
      key: 'pp-vice',
      userId: user.id,
      name: 'Vice',
      prefix: 'VICE',
      schema: VICE_TEMPLATE,
      aiPromptTemplate: VICE_TEMPLATE.ai_prompt,
      createsFollowup: true,
    });

    const gratitudeTemplate = await seeder.addFieldLogTemplate({
      key: 'pp-gratitude',
      userId: user.id,
      name: 'Gratitude',
      prefix: 'GRAT',
      schema: GRATITUDE_TEMPLATE,
      aiPromptTemplate: GRATITUDE_TEMPLATE.ai_prompt,
    });

    for (let index = 0; index < 18; index++) {
      const createdAt = addDays(asOf, -(index * 4 + 1));
      const useVice = index % 3 === 0;

      await seeder.addFieldLog({
        key: `pp-log-${index}`,
        userId: user.id,
        templateId: useVice ? viceTemplate : gratitudeTemplate,
        prefix: useVice ? 'VICE' : 'GRAT',
        content: useVice
          ? {
              trigger: 'Scrolled after a hard meeting',
              severity: rng.int(2, 8),
              response: 'Closed the app and went for a walk instead.',
              lesson: 'Put the phone in another room before meetings.',
            }
          : {
              what: 'A long uninterrupted morning',
              why: 'It let the writing session actually land.',
            },
        aiAnalysis: useVice
          ? 'This is the fourth entry triggered by post-meeting fatigue. The pattern is situational rather than habitual: the trigger is a specific time of day, which makes it addressable with an environmental change rather than willpower.'
          : 'Gratitude entries cluster around uninterrupted mornings, which correlates with your highest-XP days.',
        // Two thirds of the vice logs schedule a follow-up.
        followupReminderAt: useVice && index % 2 === 0 ? addDays(createdAt, 7) : null,
        virtueIds: useVice ? [spirit] : [spirit, service],
        createdAt,
      });
    }

    // ---------------------------------------------------------- retrospectives
    // Weekly retros land on Mondays; XP for the review is global-only, which is
    // the null-virtue ledger path.
    for (let week = 12; week >= 1; week--) {
      const periodEnd = addDays(asOf, -(week * 7));
      const periodStart = addDays(periodEnd, -6);
      const reviewed = week > 1;

      await seeder.addRetrospective({
        key: `pp-retro-w${week}`,
        userId: user.id,
        periodType: 'weekly',
        periodStart,
        periodEnd,
        status: reviewed ? 'reviewed' : 'generated',
        generatedReport: {
          summary: `Week of ${periodStart.toISOString().slice(0, 10)}: consistency held across ${rng.int(4, 7)} of 7 days.`,
          highlights: ['Streak survived a heavy travel week', 'Deep work sessions ran full length'],
          concerns: ['Service virtue is the least exercised of the six'],
          suggested_goals: ['Schedule one volunteer shift per week'],
        },
        analyticsData: {
          xp_by_virtue: { Body: rng.int(40, 90), Mind: rng.int(40, 90), Craft: rng.int(30, 80) },
          completion_rate: rng.next(),
        },
        chatHistory: reviewed
          ? [
              {
                role: 'user',
                content: 'Why did my streak nearly break?',
                created_at: periodEnd.toISOString(),
              },
              {
                role: 'assistant',
                content:
                  'Two of the three near-misses were travel days where only one routine completed.',
                created_at: periodEnd.toISOString(),
              },
            ]
          : [],
        userNotes: reviewed ? 'Travel weeks need a smaller minimum set.' : null,
        xpEarned: reviewed ? 60 : null,
        createdAt: periodEnd,
      });

      if (reviewed) {
        await seeder.addLedgerEntry({
          userId: user.id,
          virtueIds: [],
          sourceType: 'retrospective',
          sourceId: null,
          baseXp: 60,
          multiplier: 1.0,
          createdAt: periodEnd,
          description: 'Weekly retrospective reviewed',
        });
      }
    }

    for (let month = 3; month >= 1; month--) {
      const periodEnd = addDays(asOf, -(month * 30));
      const periodStart = addDays(periodEnd, -29);

      await seeder.addRetrospective({
        key: `pp-retro-m${month}`,
        userId: user.id,
        periodType: 'monthly',
        periodStart,
        periodEnd,
        status: 'reviewed',
        generatedReport: {
          summary: 'Month over month, Craft and Mind are compounding; Service is flat.',
          trends: ['Session adherence up 12%', 'Field log cadence steady'],
        },
        analyticsData: { streak_history: [12, 19, 26] },
        xpEarned: 120,
        createdAt: periodEnd,
      });

      await seeder.addLedgerEntry({
        userId: user.id,
        virtueIds: [],
        sourceType: 'retrospective',
        sourceId: null,
        baseXp: 120,
        multiplier: 1.0,
        createdAt: periodEnd,
        description: 'Monthly retrospective reviewed',
      });
    }

    // ------------------------------------------------------------ goals/quests
    const quest = await seeder.addGoal({
      key: 'pp-goal-album',
      userId: user.id,
      title: 'Record and release an EP',
      status: 'active',
      isQuest: true,
      baseXp: 750,
      dueDate: addDays(asOf, 60),
      virtueIds: [craft],
      createdAt: addDays(asOf, -60),
    });

    const subtasks = [
      {
        key: 'pp-goal-album-1',
        title: 'Write four songs',
        status: 'completed' as const,
        done: -40,
      },
      { key: 'pp-goal-album-2', title: 'Track drums', status: 'completed' as const, done: -20 },
      { key: 'pp-goal-album-3', title: 'Mix and master', status: 'active' as const, done: null },
    ];

    for (const [index, subtask] of subtasks.entries()) {
      await seeder.addGoal({
        key: subtask.key,
        userId: user.id,
        title: subtask.title,
        status: subtask.status,
        baseXp: 80,
        parentGoalId: quest,
        displayOrder: index,
        completedAt: subtask.done === null ? null : addDays(asOf, subtask.done),
        createdAt: addDays(asOf, -60),
      });

      if (subtask.done !== null) {
        await seeder.addLedgerEntry({
          userId: user.id,
          virtueIds: [craft],
          sourceType: 'goal',
          sourceId: quest,
          baseXp: 80,
          multiplier: 2.0,
          createdAt: addDays(asOf, subtask.done),
          description: `Subtask completed: ${subtask.title}`,
        });
      }
    }

    await seeder.addBacklogItem({
      key: 'pp-backlog-ai',
      userId: user.id,
      title: 'Run a weekly service block',
      notes: 'Suggested during the retro: Service is the least-exercised virtue.',
      source: 'ai_suggestion',
      virtueId: service,
      createdAt: addDays(asOf, -7),
    });

    await seeder.finalize(user.id);

    // The routine history alone produces a streak past the cap, and completed
    // sessions extend it further. Assert on what the database actually derived
    // rather than on the estimate, since the scenario's promise is about the
    // final state.
    const { rows } = await client.query<{ current_streak: number; streak_multiplier: string }>(
      'select current_streak, streak_multiplier from public.profiles where id = $1',
      [user.id],
    );

    if (rows[0].current_streak < 20 || Number(rows[0].streak_multiplier) !== 2) {
      throw new Error(
        `premium-power-user expects the streak multiplier at its 2.0 cap, got streak=${rows[0].current_streak} multiplier=${rows[0].streak_multiplier}`,
      );
    }

    if (history.completions === 0) {
      throw new Error('premium-power-user produced no routine completions');
    }

    return [user];
  },
};
