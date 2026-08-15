import { describe, it, expect } from 'vitest';
import { createTestApp, signTestToken } from '../helpers';

describe('auth middleware', () => {
  it('allows /health without a token', async () => {
    const app = createTestApp({ authenticated: false });
    const res = await app.get('/health');
    expect(res.status).toBe(200);
  });

  it('rejects a protected route with no Authorization header', async () => {
    const app = createTestApp({ authenticated: false });
    const res = await app.get('/reservation');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const app = createTestApp({ authenticated: false });
    const res = await app.get('/reservation').set('Authorization', signTestToken());
    expect(res.status).toBe(401);
  });

  it('rejects a token with a tampered signature', async () => {
    const app = createTestApp({ authenticated: false });
    const [header, payload] = signTestToken().split('.');
    const forged = `${header}.${payload}.tampered-signature`;
    const res = await app.get('/reservation').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const app = createTestApp({ authenticated: false });
    const expired = signTestToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    const res = await app.get('/reservation').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token for the wrong audience', async () => {
    const app = createTestApp({ authenticated: false });
    const wrongAud = signTestToken({ aud: 'anon' });
    const res = await app.get('/reservation').set('Authorization', `Bearer ${wrongAud}`);
    expect(res.status).toBe(401);
  });

  it('accepts a valid token and serves the protected route', async () => {
    const app = createTestApp({ authenticated: false });
    const res = await app.get('/reservation').set('Authorization', `Bearer ${signTestToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
