import { describe, it, expect } from 'vitest';
import { createTestApp } from '../../helpers';
import { seed } from '../reservation/fixtures';

// Matches the base time and hour increment used in fixtures
const T = 1700000000;
const HOUR = 3600;

// Fixture dataset time windows (epoch seconds):
//   room-a: [T, T+HOUR]  and  [T+2H, T+3H]
//   room-b: [T+H, T+2H]  and  [T+2H, T+3H]

describe('GET /availability — time range search', () => {
  it('returns 200 and an items array for a valid startTime/endTime range', async () => {
    const app = createTestApp();
    const res = await app.get('/availability').query({ startTime: T, endTime: T + HOUR });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('each item in the response has a room string property', async () => {
    const app = createTestApp();
    const res = await app.get('/availability').query({ startTime: T, endTime: T + HOUR });
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(typeof item.room).toBe('string');
    }
  });

  it('rooms booked within the queried range do not appear in results', async () => {
    const app = createTestApp();
    await seed(app); // room-a is booked [T, T+HOUR]
    const res = await app.get('/availability').query({ startTime: T, endTime: T + HOUR });
    expect(res.status).toBe(200);
    const rooms: string[] = res.body.items.map((item: { room: string }) => item.room);
    expect(rooms).not.toContain('room-a');
  });

  it('rooms with no bookings in the queried range appear in results', async () => {
    const app = createTestApp();
    await seed(app); // no reservations exist after T+3H
    const res = await app
      .get('/availability')
      .query({ startTime: T + 4 * HOUR, endTime: T + 5 * HOUR });
    expect(res.status).toBe(200);
    const rooms: string[] = res.body.items.map((item: { room: string }) => item.room);
    expect(rooms).toContain('room-a');
    expect(rooms).toContain('room-b');
  });

  it('returns no available rooms when all rooms are booked in the range', async () => {
    const app = createTestApp();
    await seed(app); // both room-a and room-b have bookings spanning [T, T+3H]
    const res = await app.get('/availability').query({ startTime: T, endTime: T + 3 * HOUR });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it('returns available rooms when only some rooms are booked in the range', async () => {
    const app = createTestApp();
    await seed(app); // room-a booked [T, T+HOUR], room-b not booked in that exact window
    // room-b is booked [T+H, T+2H], so [T, T+H] should show room-b as available
    const res = await app.get('/availability').query({ startTime: T, endTime: T + HOUR });
    expect(res.status).toBe(200);
    const rooms: string[] = res.body.items.map((item: { room: string }) => item.room);
    expect(rooms).toContain('room-b');
  });

  it('room is unavailable when its reservation is fully contained within the query range', async () => {
    const app = createTestApp();
    // Seed a reservation for room-a at [T, T+HOUR]
    // Query [T-HOUR, T+2*HOUR] fully contains it — room-a should be unavailable
    await seed(app, [{ owner: 'alice', room: 'room-a', startTime: T, endTime: T + HOUR }]);
    const res = await app
      .get('/availability')
      .query({ startTime: T - HOUR, endTime: T + 2 * HOUR });
    expect(res.status).toBe(200);
    const rooms: string[] = res.body.items.map((item: { room: string }) => item.room);
    expect(rooms).not.toContain('room-a');
  });
});

describe('GET /availability — pagination', () => {
  it('respects limit and sets nextCursor when more results exist', async () => {
    const app = createTestApp();
    await seed(app);
    const res = await app.get('/availability').query({
      startTime: T + 4 * HOUR,
      endTime: T + 5 * HOUR,
      limit: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.nextCursor).toBeTruthy();
  });

  it('does not set nextCursor when all results fit within the limit', async () => {
    const app = createTestApp();
    await seed(app);
    const res = await app.get('/availability').query({
      startTime: T + 4 * HOUR,
      endTime: T + 5 * HOUR,
      limit: 100,
    });
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeFalsy();
  });

  it('traverses all available rooms across pages using cursor', async () => {
    const app = createTestApp();
    await seed(app);

    const seen = new Set<string>();
    let cursor: string | null = null;

    do {
      const query: Record<string, unknown> = {
        startTime: T + 4 * HOUR,
        endTime: T + 5 * HOUR,
        limit: 1,
      };
      if (cursor) query.cursor = cursor;

      const res = await app.get('/availability').query(query);
      expect(res.status).toBe(200);

      for (const item of res.body.items) {
        expect(seen.has(item.room)).toBe(false);
        seen.add(item.room);
      }

      cursor = res.body.nextCursor ?? null;
    } while (cursor);

    expect(seen.size).toBeGreaterThan(0);
  });
});
