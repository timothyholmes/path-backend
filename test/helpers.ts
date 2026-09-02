import path from 'path';
import * as crypto from 'crypto';
import request from 'supertest';
import Server from '../src/server';
import { Config, Dependencies, getConfig } from '../src/config';
import { getDependencies } from '../src/dependencies';
import { getRouters } from '../src/routers';

const API_SPEC = path.resolve(__dirname, '../api-spec.yml');

const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

export type TestAgent = ReturnType<typeof request>;

interface TestAppOptions {
  /** Attach a valid bearer token to every request. Defaults to true. */
  authenticated?: boolean;
}

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Mint a Supabase-shaped HS256 JWT signed with the configured `auth.jwtSecret`,
 * so tests exercise the real `AuthService` verification path. Pass `overrides`
 * to forge expired, wrong-audience, or subject-less tokens.
 */
export function signTestToken(overrides: Record<string, unknown> = {}): string {
  const { auth } = getConfig();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: '00000000-0000-0000-0000-000000000001',
      role: 'authenticated',
      aud: auth.audience ?? 'authenticated',
      email: 'dev@example.com',
      iat: now,
      exp: now + 3600,
      ...overrides,
    }),
  );
  const signature = crypto
    .createHmac('sha256', auth.jwtSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function authHeader(token: string = signTestToken()): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

// Wrap a supertest agent so every request carries a bearer token, keeping the
// resource tests focused on behaviour rather than repeating the auth header.
export function withAuth(agent: TestAgent, token: string): TestAgent {
  return new Proxy(agent, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && (HTTP_VERBS as readonly string[]).includes(prop)) {
        return (...args: unknown[]) =>
          (value as (...a: unknown[]) => request.Test)
            .apply(target, args)
            .set('Authorization', `Bearer ${token}`);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TestAgent;
}

export function createTestApp(options: TestAppOptions = {}): TestAgent {
  const { authenticated = true } = options;
  const server = new Server<Config, Dependencies>(getConfig());
  server.withOpenApiSpec(API_SPEC).withDependencies(getDependencies).withRouters(getRouters);
  const agent = request(server.app);
  return authenticated ? withAuth(agent, signTestToken()) : agent;
}
