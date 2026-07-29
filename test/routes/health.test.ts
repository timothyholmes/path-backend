import { describe, it, expect } from 'vitest';
import { createTestApp } from '../helpers';

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const app = createTestApp();
    const res = await app.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
