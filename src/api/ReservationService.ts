import { Config, Dependencies } from '../config';
import { v4 } from 'uuid';
import Storage from './ReservationStorage';
import {
  ReservationInput,
  Reservation,
  ReservationQuery,
  Pagination,
  SearchResponse,
} from '../types';
import { NotFound } from '../errors/notFound';
import { ServerError } from '../errors/serverError';

class Service {
  config: Config;
  storage: Storage;
  logger: Console;

  constructor(config: Config, dependencies: Pick<Dependencies, 'reservationStorage' | 'logger'>) {
    this.config = config;
    this.storage = dependencies.reservationStorage;
    this.logger = dependencies.logger;
  }

  create(reservation: ReservationInput): string {
    const reservationId = v4();

    this.storage.save(reservationId, reservation);

    return reservationId;
  }

  update(reservationId: string, patch: Partial<ReservationInput>): Reservation {
    const existing = this.storage.get(reservationId);

    if (!existing) {
      throw new NotFound(`Reservation with ID ${reservationId} not found`);
    }

    const saved = this.storage.save(reservationId, { ...existing, ...patch });

    return { reservationId, ...saved };
  }

  get(reservationId: string): Reservation {
    const reservation = this.storage.get(reservationId);

    if (!reservation) {
      throw new NotFound(`Reservation with ID ${reservationId} not found`);
    }

    return { reservationId, ...reservation };
  }

  delete(reservationId: string): boolean {
    this.storage.delete(reservationId);

    const reservation = this.storage.get(reservationId);

    if (reservation) {
      throw new ServerError(`ReservationInput with ID ${reservationId} was not deleted`);
    }

    return true;
  }

  search(query: ReservationQuery, pagination: Pagination): SearchResponse<Reservation> {
    const items: Reservation[] = [];
    let nextCursor: string | undefined;
    let skipping = !!pagination.cursor;

    for (const [id, reservation] of this.storage) {
      if (skipping) {
        if (id === pagination.cursor) skipping = false;
        else continue;
      }

      const match = (Object.entries(query) as Array<[keyof ReservationInput, string]>).every(
        ([key, value]) => reservation[key] === value,
      );

      if (match) {
        items.push({ reservationId: id, ...reservation });
      }

      if (items.length === pagination.limit + 1) {
        const next = items.pop();
        nextCursor = next?.reservationId;
        break;
      }
    }

    return { nextCursor, items };
  }
}

export default Service;
