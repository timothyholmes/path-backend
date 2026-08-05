import { Scenario } from '../types';

/**
 * Creates nothing. Useful as the baseline for tests that need a migrated but
 * completely empty database, and to confirm the seeder itself is inert when a
 * scenario writes no rows.
 */
export const empty: Scenario = {
  name: 'empty',
  description: 'No data. A migrated database with zero users.',
  async run() {
    return [];
  },
};
