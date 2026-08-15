import express, { Router } from 'express';
import { Config, Dependencies } from './config';
import { Reservation } from './api/reservation/ReservationRouter';
import { AvailabilityRouter } from './api/availability/AvailabilityRouter';

export function getRouters(config: Config, dependencies: Dependencies) {
  const router: Router = express.Router();

  const reservation = new Reservation(config, dependencies);

  const availability = new AvailabilityRouter(config, dependencies);

  router.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  router.post(`/reservation`, reservation.create.bind(reservation));
  router.get(`/reservation`, reservation.search.bind(reservation));
  router.get(`/reservation/:reservationId`, reservation.getById.bind(reservation));
  router.patch(`/reservation/:reservationId`, reservation.update.bind(reservation));
  router.delete(`/reservation/:reservationId`, reservation.delete.bind(reservation));

  router.get(`/availability`, availability.search.bind(availability));

  return [router];
}
