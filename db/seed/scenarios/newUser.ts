import { Scenario } from '../types';

/**
 * A user who has just signed up: the profile and four starter virtues the
 * signup trigger creates, and nothing else. Exercises the empty states of every
 * screen -- zero XP, level 1, no streak, no history.
 */
export const newUser: Scenario = {
  name: 'new-user',
  description: 'One freshly signed-up free user with default virtues and no activity.',
  async run({ seeder }) {
    const user = await seeder.addUser({
      key: 'new-user',
      email: 'new@path.test',
      displayName: 'Nadia New',
      timezone: 'Europe/Lisbon',
      tier: 'free',
    });

    await seeder.finalize(user.id);

    return [user];
  },
};
