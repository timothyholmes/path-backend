import { Client } from 'pg';
import { v4 as uuid } from 'uuid';
import { createAuthUser } from '../../../db/seed/authUsers';

export interface SeededUser {
  id: string;
  /** The four starter virtues (Body, Mind, Craft, Spirit) created by the signup trigger. */
  virtueIds: string[];
}

export interface SeedUserOptions {
  timezone?: string;
  /** Defaults to the `free` tier the signup trigger creates. */
  tier?: 'free' | 'premium';
  /** Null (the default for a premium user) means the subscription never lapses. */
  subscriptionExpiresAt?: Date | null;
}

/**
 * Inserts an auth user via the same path a real signup takes, so the profile
 * row and four starter virtues are created by `public.handle_new_user()`
 * rather than duplicated here. Subscription state, which signup does not set,
 * is applied afterwards.
 */
export async function seedUser(client: Client, options: SeedUserOptions = {}): Promise<SeededUser> {
  const id = uuid();
  await createAuthUser(client, {
    id,
    email: `${id}@example.com`,
    timezone: options.timezone ?? 'UTC',
  });

  if (options.tier !== undefined || options.subscriptionExpiresAt !== undefined) {
    await client.query(
      `update public.profiles
          set subscription_tier = coalesce($2::public.subscription_tier, subscription_tier),
              subscription_expires_at = $3
        where id = $1`,
      [id, options.tier ?? null, options.subscriptionExpiresAt ?? null],
    );
  }

  const { rows } = await client.query<{ id: string }>(
    `select id from public.virtues where user_id = $1 order by display_order`,
    [id],
  );

  return { id, virtueIds: rows.map((row) => row.id) };
}
