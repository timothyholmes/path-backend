import { ReservationInput } from '../src/types';

const T = 1700000000;
const HOUR = 3600;

// 6 reservations: alice x3, bob x2, carol x1 across two rooms
//
// owner  | room   | count
// -------+--------+------
// alice  | room-a |   2
// alice  | room-b |   1
// bob    | room-a |   1
// bob    | room-b |   1
// carol  | room-b |   1

export const dataset: ReservationInput[] = [
  { owner: 'alice', room: 'room-a', startTime: T, endTime: T + HOUR },
  { owner: 'alice', room: 'room-a', startTime: T + 2 * HOUR, endTime: T + 3 * HOUR },
  { owner: 'alice', room: 'room-b', startTime: T + HOUR, endTime: T + 2 * HOUR },
  { owner: 'bob', room: 'room-a', startTime: T, endTime: T + HOUR },
  { owner: 'bob', room: 'room-b', startTime: T + HOUR, endTime: T + 2 * HOUR },
  { owner: 'carol', room: 'room-b', startTime: T + 2 * HOUR, endTime: T + 3 * HOUR },
];

export async function seed(
  app: ReturnType<typeof import('supertest').default>,
  data: ReservationInput[] = dataset,
): Promise<string[]> {
  const ids: string[] = [];
  for (const reservation of data) {
    const res = await app.post('/reservation').send(reservation);
    ids.push(res.body.reservationId);
  }
  return ids;
}
