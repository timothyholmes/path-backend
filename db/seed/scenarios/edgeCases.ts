import { addDays, atHour } from '../rng';
import { Scenario } from '../types';

/**
 * The states that break things, gathered into one scenario so they are always
 * present in a seeded database rather than only appearing in production:
 *
 *  - a streak that broke yesterday (current_streak must read 0, not stale)
 *  - global-only XP with a null virtue_id
 *  - net-negative XP from penalties, which pushes a virtue below zero
 *  - ledger rows on both sides of a month boundary, so partition routing runs
 *  - four levels of goal nesting
 *  - a lapsed premium subscription, which must be treated as free by the caps
 *  - a user in a UTC+13 timezone, where "today" differs from the UTC date
 */
export const edgeCases: Scenario = {
  name: 'edge-cases',
  description:
    'Broken streaks, negative XP, null-virtue ledger rows, partition boundaries, deep nesting, and a lapsed subscription.',
  async run({ seeder, asOf }) {
    await seeder.ensureLedgerPartitions(6);

    // ---------------------------------------------------- broken streak user
    const broken = await seeder.addUser({
      key: 'edge-broken-streak',
      email: 'broken@path.test',
      displayName: 'Bea Broken',
      timezone: 'UTC',
      tier: 'free',
    });

    const brokenVirtues = await seeder.virtueIds(broken.id);

    const brokenRoutine = await seeder.addRoutine({
      key: 'edge-broken-routine',
      userId: broken.id,
      title: 'Daily walk',
      frequency: 'daily',
      virtueIds: [brokenVirtues[0]],
      createdAt: addDays(asOf, -30),
    });

    // A run that ended two days ago: nothing yesterday, nothing today.
    for (let offset = 9; offset >= 2; offset--) {
      const completedAt = atHour(addDays(asOf, -offset), 8);

      await seeder.completeRoutine({
        routineId: brokenRoutine,
        userId: broken.id,
        completedAt,
        xpEarned: 10,
        multiplier: 1.0,
      });

      await seeder.addLedgerEntry({
        userId: broken.id,
        virtueIds: [brokenVirtues[0]],
        sourceType: 'routine',
        sourceId: brokenRoutine,
        baseXp: 10,
        multiplier: 1.0,
        createdAt: completedAt,
        description: 'Routine completed',
      });
    }

    await seeder.finalize(broken.id);

    // ------------------------------------------------- negative / global XP
    const negative = await seeder.addUser({
      key: 'edge-negative-xp',
      email: 'negative@path.test',
      displayName: 'Nils Negative',
      timezone: 'UTC',
      tier: 'free',
    });

    const negativeVirtues = await seeder.virtueIds(negative.id);

    const skippedSession = await seeder.addSession({
      key: 'edge-skipped-session',
      userId: negative.id,
      title: 'Never-happens session',
      targetDurationMinutes: 90,
      virtueIds: [negativeVirtues[0]],
      createdAt: addDays(asOf, -20),
    });

    // Five skips and no completions: the virtue total goes below zero, and the
    // level function has to clamp at 1 rather than error.
    for (let offset = 5; offset >= 1; offset--) {
      const scheduledAt = atHour(addDays(asOf, -offset), 10);

      await seeder.addSessionInstance({
        key: `edge-skip-${offset}`,
        sessionId: skippedSession,
        userId: negative.id,
        scheduledAt,
        status: 'skipped',
        skipPenaltyXp: 25,
      });

      await seeder.addLedgerEntry({
        userId: negative.id,
        virtueIds: [negativeVirtues[0]],
        sourceType: 'penalty',
        sourceId: skippedSession,
        baseXp: -25,
        multiplier: 1.0,
        createdAt: scheduledAt,
        description: 'Session skipped',
      });
    }

    // Global-only award: virtue_id stays null, and the design doc's original
    // function returned NULL for exactly this input.
    await seeder.addLedgerEntry({
      userId: negative.id,
      virtueIds: [],
      sourceType: 'bonus',
      sourceId: null,
      baseXp: 40,
      multiplier: 1.0,
      createdAt: atHour(addDays(asOf, -1), 12),
      description: 'Onboarding bonus (no virtue)',
    });

    await seeder.finalize(negative.id);

    // ------------------------------------------- partition boundary crossing
    const boundary = await seeder.addUser({
      key: 'edge-partition',
      email: 'partition@path.test',
      displayName: 'Pat Partition',
      timezone: 'UTC',
      tier: 'free',
    });

    const boundaryVirtues = await seeder.virtueIds(boundary.id);

    // One entry in each of the last five months, straddling four partition
    // boundaries. Written at 23:30 on the last day of the month and 00:30 on the
    // first, so a mistake in the partition bounds shows up immediately.
    for (let month = 4; month >= 0; month--) {
      const firstOfMonth = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - month, 1));
      const lastOfPrevious = addDays(firstOfMonth, -1);

      await seeder.addLedgerEntry({
        userId: boundary.id,
        virtueIds: [boundaryVirtues[0]],
        sourceType: 'bonus',
        sourceId: null,
        baseXp: 10,
        multiplier: 1.0,
        createdAt: atHour(lastOfPrevious, 23, 30),
        description: 'Last minute of the month',
      });

      await seeder.addLedgerEntry({
        userId: boundary.id,
        virtueIds: [boundaryVirtues[0]],
        sourceType: 'bonus',
        sourceId: null,
        baseXp: 10,
        multiplier: 1.0,
        createdAt: atHour(firstOfMonth, 0, 30),
        description: 'First minute of the month',
      });
    }

    await seeder.finalize(boundary.id);

    // ------------------------------------------------------- deep goal nesting
    const nested = await seeder.addUser({
      key: 'edge-nested',
      email: 'nested@path.test',
      displayName: 'Ned Nested',
      // UTC+13: the local date is tomorrow relative to UTC for part of the day,
      // which is where naive date handling breaks.
      timezone: 'Pacific/Auckland',
      tier: 'free',
    });

    let parent: string | null = null;
    for (let depth = 0; depth < 4; depth++) {
      parent = await seeder.addGoal({
        key: `edge-nested-${depth}`,
        userId: nested.id,
        title: `Level ${depth} goal`,
        status: depth === 0 ? 'active' : 'backlog',
        isQuest: depth === 0,
        baseXp: 200 - depth * 40,
        parentGoalId: parent,
        displayOrder: depth,
        createdAt: addDays(asOf, -depth - 1),
      });
    }

    await seeder.finalize(nested.id);

    // ------------------------------------------------------ lapsed premium
    const lapsed = await seeder.addUser({
      key: 'edge-lapsed',
      email: 'lapsed@path.test',
      displayName: 'Lena Lapsed',
      timezone: 'Europe/Berlin',
      tier: 'premium',
      // Still live while the data is written, so the premium-sized dataset can
      // be created; expired below.
      subscriptionExpiresAt: addDays(asOf, 30),
    });

    const lapsedVirtues = await seeder.virtueIds(lapsed.id);
    await seeder.addVirtue({
      key: 'edge-lapsed-extra',
      userId: lapsed.id,
      name: 'Legacy',
      displayOrder: 4,
      color: '#607D8B',
    });

    // Twelve active routines: over the free cap, but legitimately created while
    // premium. They must survive the lapse; only new ones get rejected.
    for (let index = 0; index < 12; index++) {
      await seeder.addRoutine({
        key: `edge-lapsed-routine-${index}`,
        userId: lapsed.id,
        title: `Premium-era routine ${index + 1}`,
        frequency: 'daily',
        virtueIds: [lapsedVirtues[index % lapsedVirtues.length]],
        createdAt: addDays(asOf, -45),
      });
    }

    await seeder.expireSubscription(lapsed.id, addDays(asOf, -3));
    await seeder.finalize(lapsed.id);

    return [broken, negative, boundary, nested, { ...lapsed, tier: 'premium' as const }];
  },
};
