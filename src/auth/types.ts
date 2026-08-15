/**
 * The identity extracted from a verified Supabase Auth JWT. Attached to every
 * authenticated request as `req.auth` by the `requireAuth` middleware.
 */
export interface AuthenticatedUser {
  /** The Supabase user id (`sub` claim) — the value RLS matches on `auth.uid()`. */
  userId: string;
  /** The Postgres role the JWT grants (`authenticated` for signed-in users). */
  role: string;
  /** The user's email, when present in the token. */
  email?: string;
  /** The full, verified set of JWT claims, for handlers that need more. */
  claims: Record<string, unknown>;
}

// Make `req.auth` visible on Express's Request across the codebase.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthenticatedUser;
    }
  }
}
