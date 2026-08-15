import { describe, it, expect } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import Server from '../src/server';
import { NotFound } from '../src/errors/notFound';

type Config = { server: { port: number } };
type Dependencies = Record<string, never>;

function appThatThrows(handler: express.RequestHandler) {
  const server = new Server<Config, Dependencies>({ server: { port: 0 } });
  server
    .withDependencies(() => ({}) as Dependencies)
    .withRouters(() => {
      const router: Router = express.Router();
      router.get('/boom', handler);
      return [router];
    });
  return request(server.app);
}

describe('Server error handler', () => {
  it('maps a ServerError to its status code and JSON shape', async () => {
    const app = appThatThrows(() => {
      throw new NotFound('missing thing');
    });
    const res = await app.get('/boom');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not Found', message: 'missing thing' });
  });

  it('maps a validator-shaped { status, message } error to that status', async () => {
    const app = appThatThrows(() => {
      throw { status: 400, message: 'request.body.name is required' };
    });
    const res = await app.get('/boom');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'request.body.name is required',
      message: 'request.body.name is required',
    });
  });

  it('falls back to a generic 500 for an unexpected error', async () => {
    const app = appThatThrows(() => {
      throw new Error('kaboom');
    });
    const res = await app.get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    });
  });
});

describe('Server wiring', () => {
  it('exposes the configured port', () => {
    const server = new Server<Config, Dependencies>({ server: { port: 4242 } });
    expect(server.PORT).toBe(4242);
  });

  it('defaults the port to 3000 when none is configured', () => {
    const server = new Server<Config, Dependencies>({ server: {} } as Config);
    expect(server.PORT).toBe(3000);
  });
});
