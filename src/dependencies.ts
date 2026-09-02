import Service from './api/reservation/ReservationService';
import Storage from './api/reservation/ReservationStorage';
import AvailabilityService from './api/availability/AvailabilityService';
import RoutineService from './api/routine/RoutineService';
import RoutineStorage from './api/routine/RoutineStorage';
import { createDbPool } from './api/shared/db';
import AuthService from './auth/AuthService';
import { Config, Dependencies } from './config';

export function getDependencies(config: Config, overrides?: Partial<Dependencies>): Dependencies {
  const logger = overrides?.logger ?? console;
  const pool = overrides?.pool ?? createDbPool(config);
  const reservationStorage = overrides?.reservationStorage ?? new Storage(config, { logger });
  const reservationService =
    overrides?.reservationService ?? new Service(config, { reservationStorage, logger });
  const availabilityService =
    overrides?.availabilityService ??
    new AvailabilityService(config, { reservationStorage, logger });
  const routineStorage = overrides?.routineStorage ?? new RoutineStorage(config, { pool, logger });
  const routineService =
    overrides?.routineService ?? new RoutineService(config, { routineStorage, logger });
  const authService = overrides?.authService ?? new AuthService(config, { logger });

  return {
    reservationService,
    reservationStorage,
    availabilityService,
    routineService,
    routineStorage,
    authService,
    pool,
    logger,
  };
}
