import { Config, Dependencies } from '../config';
import Storage from './ReservationStorage';
import { Availability, Pagination, SearchResponse, AvailabilityQuery } from '../types';

export default class Service {
  config: Config;
  storage: Storage;
  logger: Console;

  constructor(config: Config, dependencies: Pick<Dependencies, 'reservationStorage' | 'logger'>) {
    this.config = config;
    this.storage = dependencies.reservationStorage;
    this.logger = dependencies.logger;
  }

  search(query: AvailabilityQuery, pagination: Pagination): SearchResponse<Availability> {
    const allRooms = new Set<string>();
    const unavailableRooms = new Set<string>();

    for (const [, reservation] of this.storage) {
      allRooms.add(reservation.room);

      const overlaps =
        reservation.startTime < query.endTime && reservation.endTime > query.startTime;
      if (overlaps) {
        unavailableRooms.add(reservation.room);
      }
    }

    const available = [...allRooms].filter((room) => !unavailableRooms.has(room));

    let startIndex = 0;
    if (pagination.cursor) {
      const idx = available.indexOf(pagination.cursor);
      if (idx !== -1) startIndex = idx;
    }

    const page = available.slice(startIndex, startIndex + pagination.limit + 1);
    let nextCursor: string | null = null;

    if (page.length > pagination.limit) {
      nextCursor = page.pop()!;
    }

    return {
      nextCursor,
      items: page.map((room) => ({ room })),
    };
  }
}
