import { describe, it, expect } from 'vitest';
import { createTestApp } from '../helpers';
import { dataset, seed } from '../fixtures';
import type { Reservation } from '../../src/types';

// ─── CRUD ────────────────────────────────────────────────────────────────────

describe('POST /reservation', () => {
  it('returns 201 with a reservationId', async () => {
    const app = createTestApp();
    const res = await app.post('/reservation').send(dataset[0]);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('reservationId');
  });
});

describe('GET /reservation/:reservationId', () => {
  it('returns 200 with full reservation data for a known id', async () => {
    const app = createTestApp();
    const [id] = await seed(app, [dataset[0]]);

    const res = await app.get(`/reservation/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reservationId: id, ...dataset[0] });
  });

  it('returns 404 for an unknown id', async () => {
    const app = createTestApp();
    const res = await app.get('/reservation/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /reservation/:reservationId', () => {
  it('returns 200 and applies the patch without affecting other fields', async () => {
    const app = createTestApp();
    const [id] = await seed(app, [dataset[0]]);

    const res = await app.patch(`/reservation/${id}`).send({ room: 'room-z' });
    expect(res.status).toBe(200);
    expect(res.body.room).toBe('room-z');
    expect(res.body.owner).toBe(dataset[0].owner);
    expect(res.body.startTime).toBe(dataset[0].startTime);
    expect(res.body.endTime).toBe(dataset[0].endTime);
  });

  it('returns 404 when patching a non-existent reservation', async () => {
    const app = createTestApp();
    const res = await app.patch('/reservation/does-not-exist').send({ room: 'room-z' });
    expect(res.status).toBe(404);
  });

  it('subsequent get reflects the patched value', async () => {
    const app = createTestApp();
    const [id] = await seed(app, [dataset[0]]);

    await app.patch(`/reservation/${id}`).send({ owner: 'dave' });

    const res = await app.get(`/reservation/${id}`);
    expect(res.body.owner).toBe('dave');
  });
});

describe('DELETE /reservation/:reservationId', () => {
  it('returns 204', async () => {
    const app = createTestApp();
    const [id] = await seed(app, [dataset[0]]);

    const res = await app.delete(`/reservation/${id}`);
    expect(res.status).toBe(204);
  });

  it('deleted reservation returns 404 on subsequent get', async () => {
    const app = createTestApp();
    const [id] = await seed(app, [dataset[0]]);

    await app.delete(`/reservation/${id}`);

    const res = await app.get(`/reservation/${id}`);
    expect(res.status).toBe(404);
  });
});

// ─── Search ───────────────────────────────────────────────────────────────────

describe('GET /reservation — single-field search', () => {
  it('returns all 3 reservations for owner=alice', async () => {
    const app = createTestApp();
    await seed(app);

    const res = await app.get('/reservation').query({ owner: 'alice' });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items.every((r: Reservation) => r.owner === 'alice')).toBe(true);
  });

  it('returns all 2 reservations for owner=bob', async () => {
    const app = createTestApp();
    await seed(app);

    const res = await app.get('/reservation').query({ owner: 'bob' });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.every((r: Reservation) => r.owner === 'bob')).toBe(true);
  });

  it('returns 1 reservation for owner=carol', async () => {
    const app = createTestApp();
    await seed(app);

    const res = await app.get('/reservation').query({ owner: 'carol' });
    expect(res.body.items).toHaveLength(1);
  });

  it('returns 3 reservations for room=room-a', async () => {
    const app = createTestApp();
    await seed(app);

    const res = await app.get('/reservation').query({ room: 'room-a' });
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items.every((r: Reservation) => r.room === 'room-a')).toBe(true);
  });

  it('returns 3 reservations for room=room-b', async () => {
    const app = createTestApp();
    await seed(app);

    const res = await app.get('/reservation').query({ room: 'room-b' });
    expect(res.body.items).toHaveLength(3);
  });

  it('returns 0 results for an unknown owner', async () => {
    const app = createTestApp();
    await seed(app);

    const res = await app.get('/reservation').query({ owner: 'nobody' });
    expect(res.body.items).toHaveLength(0);
  });
});

describe('GET /reservation — multi-field search', () => {
  it('returns 2 results for owner=alice, room=room-a', async () => {
    const app = createTestApp();
    await seed(app);

    const res = await app.get('/reservation').query({ owner: 'alice', room: 'room-a' });
    expect(res.body.items).toHaveLength(2);
    expect(
      res.body.items.every((r: Reservation) => r.owner === 'alice' && r.room === 'room-a'),
    ).toBe(true);
  });

  it('returns 1 result for owner=alice, room=room-b', async () => {
    const app = createTestApp();
    await seed(app);

    const res = await app.get('/reservation').query({ owner: 'alice', room: 'room-b' });
    expect(res.body.items).toHaveLength(1);
  });

  it('returns 1 result for owner=bob, room=room-a', async () => {
    const app = createTestApp();
    await seed(app);

    const res = await app.get('/reservation').query({ owner: 'bob', room: 'room-a' });
    expect(res.body.items).toHaveLength(1);
  });

  it('returns 0 results for owner=carol, room=room-a', async () => {
    const app = createTestApp();
    await seed(app);

    const res = await app.get('/reservation').query({ owner: 'carol', room: 'room-a' });
    expect(res.body.items).toHaveLength(0);
  });
});

// ─── Pagination ───────────────────────────────────────────────────────────────

describe('GET /reservation — pagination', () => {
  it('respects limit and sets nextCursor when more results exist', async () => {
    const app = createTestApp();
    await seed(app);

    const res = await app.get('/reservation').query({ owner: 'alice', limit: 2 });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.nextCursor).toBeTruthy();
  });

  it('does not set nextCursor when all results fit within the limit', async () => {
    const app = createTestApp();
    await seed(app);

    const res = await app.get('/reservation').query({ owner: 'alice', limit: 3 });
    expect(res.body.items).toHaveLength(3);
    expect(res.body.nextCursor).toBeFalsy();
  });

  it('does not set nextCursor when limit exceeds total results', async () => {
    const app = createTestApp();
    await seed(app);

    const res = await app.get('/reservation').query({ owner: 'alice', limit: 10 });
    expect(res.body.items).toHaveLength(3);
    expect(res.body.nextCursor).toBeFalsy();
  });

  it('nextCursor is the reservationId of the next item', async () => {
    const app = createTestApp();
    const ids = await seed(app);

    const res = await app.get('/reservation').query({ limit: 2 });
    const cursor = res.body.nextCursor;

    expect(ids).toContain(cursor);
  });

  it('traverses all results across pages using limit=2', async () => {
    const app = createTestApp();
    await seed(app);

    const seen = new Set<string>();
    let cursor: string | null = null;

    do {
      const query: Record<string, unknown> = { limit: 2 };
      if (cursor) query.cursor = cursor;

      const res = await app.get('/reservation').query(query);
      expect(res.status).toBe(200);

      for (const item of res.body.items) {
        expect(seen.has(item.reservationId)).toBe(false);
        seen.add(item.reservationId);
      }

      cursor = res.body.nextCursor ?? null;
    } while (cursor);

    expect(seen.size).toBe(dataset.length);
  });
});
