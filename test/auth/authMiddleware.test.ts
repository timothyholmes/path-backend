import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { requireAuth } from '../../src/auth/authMiddleware';
import AuthService from '../../src/auth/AuthService';
import { Unauthorized } from '../../src/errors/unauthorized';
import type { AuthenticatedUser } from '../../src/auth/types';

const silentLogger = { debug: () => {} } as unknown as Console;

function run(authService: Pick<AuthService, 'verifyToken'>, header?: string): unknown {
  const middleware = requireAuth({ authService: authService as AuthService, logger: silentLogger });
  const req = {
    header: () => header,
    method: 'GET',
    path: '/protected',
  } as unknown as Request;
  let captured: unknown = 'not-called';
  middleware(req, {} as Response, (err?: unknown) => {
    captured = err;
  });
  return captured;
}

describe('requireAuth middleware', () => {
  it('passes an Unauthorized to next when the header is missing', () => {
    const err = run({ verifyToken: () => ({}) as AuthenticatedUser });
    expect(err).toBeInstanceOf(Unauthorized);
  });

  it('wraps a non-Unauthorized verification error as a generic Unauthorized', () => {
    const err = run(
      {
        verifyToken: () => {
          throw new TypeError('unexpected internal failure');
        },
      },
      'Bearer some-token',
    );
    expect(err).toBeInstanceOf(Unauthorized);
    expect((err as Unauthorized).message).toBe('Invalid authentication token');
  });

  it('calls next with no error and sets req.auth on success', () => {
    const user: AuthenticatedUser = {
      userId: 'u1',
      role: 'authenticated',
      claims: { sub: 'u1' },
    };
    const middleware = requireAuth({
      authService: { verifyToken: () => user } as unknown as AuthService,
      logger: silentLogger,
    });
    const req = { header: () => 'Bearer good', method: 'GET', path: '/p' } as unknown as Request;
    let called = false;
    middleware(req, {} as Response, (err?: unknown) => {
      expect(err).toBeUndefined();
      called = true;
    });
    expect(called).toBe(true);
    expect(req.auth).toBe(user);
  });
});
