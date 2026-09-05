import express, { Router } from 'express';
import { Config, Dependencies } from './config';
import { Reservation } from './api/reservation/ReservationRouter';
import { AvailabilityRouter } from './api/availability/AvailabilityRouter';
import { RoutineRouter } from './api/routine/RoutineRouter';
import { requireAuth } from './auth/authMiddleware';

export function getRouters(config: Config, dependencies: Dependencies) {
  const router: Router = express.Router();

  const reservation = new Reservation(config, dependencies);

  const availability = new AvailabilityRouter(config, dependencies);

  const routine = new RoutineRouter(config, dependencies);

  // Gate every data route behind a valid Supabase Auth JWT. `/health` (and the
  // Swagger UI mounted in `Server`) stay public.
  const auth = requireAuth(dependencies);

  router.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  router.post(`/reservation`, auth, reservation.create.bind(reservation));
  router.get(`/reservation`, auth, reservation.search.bind(reservation));
  router.get(`/reservation/:reservationId`, auth, reservation.getById.bind(reservation));
  router.patch(`/reservation/:reservationId`, auth, reservation.update.bind(reservation));
  router.delete(`/reservation/:reservationId`, auth, reservation.delete.bind(reservation));

  router.get(`/availability`, auth, availability.search.bind(availability));

  router.get(`/routines`, auth, routine.list.bind(routine));
  router.post(`/routines`, auth, routine.create.bind(routine));
  router.patch(`/routines/:id`, auth, routine.update.bind(routine));
  router.delete(`/routines/:id`, auth, routine.delete.bind(routine));
  router.post(`/routines/:id/complete`, auth, routine.complete.bind(routine));

  return [router];
}
