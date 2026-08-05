import { Rng, addDays, atHour } from './rng';
import { Seeder } from './generators';

export interface HistoricalRoutine {
  id: string;
  baseXp: number;
  virtueIds: string[];
  frequency: 'daily' | 'weekly' | 'monthly';
  scheduledDay: number | null;
}

function isDue(routine: HistoricalRoutine, day: Date): boolean {
  switch (routine.frequency) {
    case 'daily':
      return true;
    case 'weekly':
      return day.getUTCDay() === routine.scheduledDay;
    case 'monthly':
      return day.getUTCDate() === routine.scheduledDay;
  }
}

/** multiplier = min(1.0 + streak_days * 0.05, 2.0), matching recalculate_streak(). */
export function streakMultiplier(streakDays: number): number {
  return Math.min(1 + streakDays * 0.05, 2);
}

/** 1.0 + 0.10 * (virtue_count - 1), matching calculate_and_award_xp(). */
export function virtueBonus(virtueCount: number): number {
  return 1 + 0.1 * Math.max(virtueCount - 1, 0);
}

export interface HistoryOptions {
  seeder: Seeder;
  rng: Rng;
  userId: string;
  asOf: Date;
  days: number;
  routines: HistoricalRoutine[];
  /** Probability that a due routine is actually completed on a given day. */
  adherence: number;
  /**
   * Days back from asOf that are forced to have no activity at all. Used to
   * produce a deliberately broken streak.
   */
  skipDays?: number[];
}

export interface HistoryResult {
  finalStreak: number;
  completions: number;
  totalXp: number;
}

/**
 * Replays `days` of routine activity ending at `asOf`, tracking the streak as it
 * goes so each day's XP carries the multiplier that day would really have had.
 *
 * The streak is advanced only by days with at least one completion, which is the
 * same rule recalculate_streak() applies, so calling finalize() afterwards
 * reproduces the streak this loop computed.
 */
export async function simulateRoutineHistory(options: HistoryOptions): Promise<HistoryResult> {
  const { seeder, rng, userId, asOf, days, routines, adherence } = options;
  const skipDays = new Set(options.skipDays ?? []);

  let streak = 0;
  let completions = 0;
  let totalXp = 0;

  for (let offset = days - 1; offset >= 0; offset--) {
    const day = addDays(asOf, -offset);
    const forcedIdle = skipDays.has(offset);
    const due = routines.filter((routine) => isDue(routine, day));

    const completedToday = forcedIdle ? [] : due.filter(() => rng.bool(adherence));

    if (completedToday.length === 0) {
      streak = 0;
      continue;
    }

    // The multiplier in force during a day reflects the streak going into it.
    streak += 1;
    const multiplier = streakMultiplier(streak);

    for (const routine of completedToday) {
      const combined = multiplier * virtueBonus(routine.virtueIds.length);
      const completedAt = atHour(day, rng.int(6, 21), rng.int(0, 59));

      await seeder.completeRoutine({
        routineId: routine.id,
        userId,
        completedAt,
        xpEarned: Math.floor(routine.baseXp * combined),
        multiplier,
      });

      totalXp += await seeder.addLedgerEntry({
        userId,
        virtueIds: routine.virtueIds,
        sourceType: 'routine',
        sourceId: routine.id,
        baseXp: routine.baseXp,
        multiplier: combined,
        createdAt: completedAt,
        description: 'Routine completed',
      });

      completions += 1;
    }
  }

  return { finalStreak: streak, completions, totalXp };
}
