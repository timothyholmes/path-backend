import Service from './api/reservation/ReservationService';
import Storage from './api/reservation/ReservationStorage';
import AvailabilityService from './api/availability/AvailabilityService';
import { Config, Dependencies } from './config';

export function getDependencies(config: Config, overrides?: Partial<Dependencies>): Dependencies {
  const logger = overrides?.logger ?? console;
  const reservationStorage = overrides?.reservationStorage ?? new Storage(config, { logger });
  const reservationService =
    overrides?.reservationService ?? new Service(config, { reservationStorage, logger });
  const availabilityService =
    overrides?.availabilityService ??
    new AvailabilityService(config, { reservationStorage, logger });

  return {
    reservationService,
    reservationStorage,
    availabilityService,
    logger,
  };
}
