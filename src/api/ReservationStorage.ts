import { Config, Dependencies } from '../config';
import { ReservationInput } from '../types';
import { ServerError } from '../errors/serverError';

class Storage {
  config: Config;
  store: Map<string, ReservationInput>;
  logger: Console;

  constructor(config: Config, dependencies: Pick<Dependencies, 'logger'>) {
    this.config = config;
    this.store = new Map();
    this.logger = dependencies.logger;
  }

  save(reservationId: string, reservationData: ReservationInput): ReservationInput {
    const existingReservation = this.store.get(reservationId);

    if (existingReservation) {
      const updatedReservationInput = {
        ...existingReservation,
        ...reservationData,
      };

      this.store.set(reservationId, updatedReservationInput);
    } else {
      try {
        this.store.set(reservationId, reservationData);
      } catch (error) {
        this.logger.error('Failed to save reservation:', error);
        throw new ServerError('Failed to save reservation', 500, 'StorageError', error as Error);
      }
    }

    const savedReservation = this.store.get(reservationId);

    if (!savedReservation) {
      this.logger.error(`Failed to save reservation. Reservation ID: ${reservationId}`);
      throw new ServerError('Failed to save reservation', 500, 'StorageError');
    }

    return savedReservation;
  }

  get(reservationId: string): ReservationInput | null {
    return this.store.get(reservationId) || null;
  }

  delete(reservationId: string): boolean {
    this.store.delete(reservationId);

    return true;
  }

  [Symbol.iterator](): Iterator<[string, ReservationInput], undefined> {
    let current = 0;
    const end = this.store.size - 1;
    const storage = Array.from(this.store.entries());

    return {
      next(): IteratorResult<[string, ReservationInput], undefined> {
        if (current <= end) {
          const value = storage[current];
          current++;
          return { value, done: false };
        }
        return { value: undefined, done: true };
      },
    };
  }
}

export default Storage;
