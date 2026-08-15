import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import AuthService from '../../src/auth/AuthService';
import type { Config } from '../../src/config';
import { Unauthorized } from '../../src/errors/unauthorized';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const silentLogger = { debug: () => {} } as unknown as Console;

function makeService(overrides: Partial<Config['auth']> = {}): AuthService {
  const config = {
    server: { port: 0 },
    auth: { jwtSecret: SECRET, audience: 'authenticated', ...overrides },
  } as Config;
  return new AuthService(config, { logger: silentLogger });
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(
  payload: unknown,
  secret = SECRET,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const head = b64url(header);
  const body = b64url(payload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${head}.${body}`)
    .digest('base64url');
  return `${head}.${body}.${signature}`;
}

const validPayload = () => ({
  sub: 'user-123',
  role: 'authenticated',
  aud: 'authenticated',
  email: 'user@example.com',
  exp: Math.floor(Date.now() / 1000) + 3600,
});

describe('AuthService construction', () => {
  it('throws when no jwtSecret is configured', () => {
    const config = { server: { port: 0 }, auth: { jwtSecret: '' } } as Config;
    expect(() => new AuthService(config, { logger: silentLogger })).toThrow(/jwtSecret/);
  });
});

describe('AuthService.verifyToken — valid tokens', () => {
  it('returns the identity from a well-formed token', () => {
    const user = makeService().verifyToken(sign(validPayload()));
    expect(user).toMatchObject({
      userId: 'user-123',
      role: 'authenticated',
      email: 'user@example.com',
    });
    expect(user.claims.sub).toBe('user-123');
  });

  it('defaults role to "authenticated" when the claim is absent', () => {
    const { role: _role, ...noRole } = validPayload();
    expect(makeService().verifyToken(sign(noRole)).role).toBe('authenticated');
  });

  it('leaves email undefined when the claim is absent', () => {
    const { email: _email, ...noEmail } = validPayload();
    expect(makeService().verifyToken(sign(noEmail)).email).toBeUndefined();
  });

  it('accepts a token whose aud is an array containing the expected audience', () => {
    const token = sign({ ...validPayload(), aud: ['authenticated', 'other'] });
    expect(makeService().verifyToken(token).userId).toBe('user-123');
  });

  it('skips the audience check when no audience is configured', () => {
    const service = makeService({ audience: undefined });
    const token = sign({ ...validPayload(), aud: 'anything-goes' });
    expect(service.verifyToken(token).userId).toBe('user-123');
  });

  it('accepts a token whose nbf is in the past', () => {
    const token = sign({ ...validPayload(), nbf: Math.floor(Date.now() / 1000) - 60 });
    expect(makeService().verifyToken(token).userId).toBe('user-123');
  });
});

describe('AuthService.verifyToken — rejections', () => {
  const service = makeService();
  const expectUnauthorized = (token: string) =>
    expect(() => service.verifyToken(token)).toThrow(Unauthorized);

  it('rejects a token without three segments', () => {
    expectUnauthorized('only.two');
  });

  it('rejects an unsupported signing algorithm', () => {
    expectUnauthorized(sign(validPayload(), SECRET, { alg: 'none', typ: 'JWT' }));
  });

  it('rejects a token signed with a different secret', () => {
    expectUnauthorized(sign(validPayload(), 'a-different-secret-of-sufficient-length!!'));
  });

  it('rejects a token with a tampered signature', () => {
    const [head, body] = sign(validPayload()).split('.');
    expectUnauthorized(`${head}.${body}.tampered`);
  });

  it('rejects an expired token', () => {
    expectUnauthorized(sign({ ...validPayload(), exp: Math.floor(Date.now() / 1000) - 1 }));
  });

  it('rejects a token whose nbf is in the future', () => {
    expectUnauthorized(sign({ ...validPayload(), nbf: Math.floor(Date.now() / 1000) + 3600 }));
  });

  it('rejects a token for the wrong audience', () => {
    expectUnauthorized(sign({ ...validPayload(), aud: 'anon' }));
  });

  it('rejects a token missing a subject', () => {
    const { sub: _sub, ...noSub } = validPayload();
    expectUnauthorized(sign(noSub));
  });

  it('rejects a token with an empty subject', () => {
    expectUnauthorized(sign({ ...validPayload(), sub: '' }));
  });

  it('rejects a token whose payload is not a JSON object', () => {
    expectUnauthorized(sign(42));
  });

  it('rejects a token whose payload is a JSON array', () => {
    expectUnauthorized(sign([1, 2, 3]));
  });

  it('rejects a token whose header is not valid base64url JSON', () => {
    const body = b64url(validPayload());
    expectUnauthorized(`not-json.${body}.sig`);
  });
});
