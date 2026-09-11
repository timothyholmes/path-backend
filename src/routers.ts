import express, { Router } from 'express';
import { Config, Dependencies } from './config';
import { Reservation } from './api/reservation/ReservationRouter';
import { AvailabilityRouter } from './api/availability/AvailabilityRouter';
import { RoutineRouter } from './api/routine/RoutineRouter';
import { SessionRouter } from './api/session/SessionRouter';
import { GoalRouter } from './api/goal/GoalRouter';
import { requireAuth } from './auth/authMiddleware';

export function getRouters(config: Config, dependencies: Dependencies) {
  const router: Router = express.Router();

  const reservation = new Reservation(config, dependencies);

  const availability = new AvailabilityRouter(config, dependencies);

  const routine = new RoutineRouter(config, dependencies);

  const session = new SessionRouter(config, dependencies);

  const goal = new GoalRouter(config, dependencies);

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

  router.get(`/sessions`, auth, session.list.bind(session));
  router.post(`/sessions`, auth, session.create.bind(session));
  router.patch(`/sessions/:id`, auth, session.update.bind(session));
  router.delete(`/sessions/:id`, auth, session.delete.bind(session));
  router.post(`/sessions/:id/start`, auth, session.start.bind(session));
  router.post(`/sessions/:id/end`, auth, session.end.bind(session));
  router.post(`/sessions/:id/skip`, auth, session.skip.bind(session));

  // No backlog path collides with a goal path today — `/goals/backlog/:id` has
  // one more segment than `/goals/:id`, and there is no `GET /goals/:id` — but
  // the literal routes are registered first so that adding one later cannot
  // quietly shadow `/goals/backlog`.
  router.get(`/goals/backlog`, auth, goal.listBacklog.bind(goal));
  router.post(`/goals/backlog`, auth, goal.createBacklogItem.bind(goal));
  router.patch(`/goals/backlog/:id`, auth, goal.updateBacklogItem.bind(goal));
  router.delete(`/goals/backlog/:id`, auth, goal.deleteBacklogItem.bind(goal));
  router.post(`/goals/backlog/:id/promote`, auth, goal.promoteBacklogItem.bind(goal));

  router.get(`/goals`, auth, goal.list.bind(goal));
  router.post(`/goals`, auth, goal.create.bind(goal));
  router.patch(`/goals/:id`, auth, goal.update.bind(goal));
  router.delete(`/goals/:id`, auth, goal.delete.bind(goal));
  router.post(`/goals/:id/complete`, auth, goal.complete.bind(goal));

  return [router];
}
