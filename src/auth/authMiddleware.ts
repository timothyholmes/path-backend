import { NextFunction, Request, RequestHandler, Response } from 'express';
import { Dependencies } from '../config';
import { Unauthorized } from '../errors/unauthorized';

const BEARER_PREFIX = 'Bearer ';

/**
 * Express middleware factory that requires a valid Supabase Auth JWT. It reads
 * the `Authorization: Bearer <JWT>` header, verifies it via `AuthService`, and
 * attaches the identity as `req.auth` for downstream handlers. Any failure is
 * passed to the global error handler as an `Unauthorized` (401).
 *
 * Mount it per route (or route group) in `src/routers.ts`:
 *
 *   const auth = requireAuth(dependencies);
 *   router.post('/reservation', auth, reservation.create.bind(reservation));
 */
export function requireAuth(
  dependencies: Pick<Dependencies, 'authService' | 'logger'>,
): RequestHandler {
  const { authService, logger } = dependencies;

  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('authorization');
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      return next(new Unauthorized('Missing or malformed Authorization header'));
    }

    const token = header.slice(BEARER_PREFIX.length).trim();
    try {
      req.auth = authService.verifyToken(token);
      return next();
    } catch (err) {
      if (err instanceof Unauthorized) {
        logger.debug?.(`Rejected request to ${req.method} ${req.path}: ${err.message}`);
        return next(err);
      }
      return next(new Unauthorized('Invalid authentication token'));
    }
  };
}
