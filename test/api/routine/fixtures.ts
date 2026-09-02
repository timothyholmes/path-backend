import { Client } from 'pg';
import { v4 as uuid } from 'uuid';
import { createAuthUser } from '../../../db/seed/authUsers';

export interface SeededUser {
  id: string;
  /** The four starter virtues (Body, Mind, Craft, Spirit) created by the signup trigger. */
  virtueIds: string[];
}

/**
 * Inserts an auth user via the same path a real signup takes, so the profile
 * row and four starter virtues are created by `public.handle_new_user()`
 * rather than duplicated here.
 */
export async function seedUser(client: Client, timezone = 'UTC'): Promise<SeededUser> {
  const id = uuid();
  await createAuthUser(client, { id, email: `${id}@example.com`, timezone });

  const { rows } = await client.query<{ id: string }>(
    `select id from public.virtues where user_id = $1 order by display_order`,
    [id],
  );

  return { id, virtueIds: rows.map((row) => row.id) };
}
