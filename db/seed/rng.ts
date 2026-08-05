import { v5 as uuidv5 } from 'uuid';

/**
 * Fixed namespace for every generated seed id. Because ids are derived from a
 * stable name rather than randomly generated, the same scenario produces the
 * same primary keys on every run, on every machine -- so tests can reference
 * seeded rows by literal id.
 */
export const SEED_NAMESPACE = '9a7b2c1d-5e3f-4a8b-9c0d-1e2f3a4b5c6d';

export function seedId(name: string): string {
  return uuidv5(name, SEED_NAMESPACE);
}

/**
 * mulberry32: a small, fast, well-distributed PRNG. Used instead of
 * Math.random() so that a scenario's "random" choices -- which routine was
 * skipped on day 12, how long a session actually ran -- are reproducible.
 */
export class Rng {
  private state: number;

  constructor(seed: string) {
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    this.state = hash >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(probabilityTrue: number): boolean {
    return this.next() < probabilityTrue;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Rng.pick() called with an empty array');
    }
    return items[Math.floor(this.next() * items.length)];
  }
}

/** Midnight UTC on the given date, offset by whole days. */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/** `YYYY-MM-DD` in UTC, which is how DATE columns are written. */
export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A timestamp at a given hour on the given day, for plausible-looking history. */
export function atHour(date: Date, hour: number, minute = 0): Date {
  const result = new Date(date.getTime());
  result.setUTCHours(hour, minute, 0, 0);
  return result;
}
