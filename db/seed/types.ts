import { Client } from 'pg';
import { Rng } from './rng';
import { Seeder } from './generators';

export interface SeedContext {
  client: Client;
  seeder: Seeder;
  rng: Rng;
  /**
   * The date the scenario treats as "today". Defaults to the real current date
   * so that a scenario describing a live 20-day streak actually produces one;
   * override it to pin history for a regression test.
   */
  asOf: Date;
}

export interface SeededUser {
  id: string;
  email: string;
  tier: 'free' | 'premium';
}

export interface SeedSummary {
  scenario: string;
  users: SeededUser[];
  counts: Record<string, number>;
}

export interface Scenario {
  name: string;
  description: string;
  run(context: SeedContext): Promise<SeededUser[]>;
}
