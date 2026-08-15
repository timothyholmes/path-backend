import { StatusCodes } from 'http-status-codes';
import { Config, Dependencies } from '../../config';
import { Request, Response } from 'express';
import { ReservationQuery, Pagination } from '../../types';
import { BadRequest } from '../../errors/badRequest';

export class Reservation {
  config: Config;
  dependencies: Dependencies;

  constructor(config: Config, dependencies: Dependencies) {
    this.config = config;
    this.dependencies = dependencies;
  }

  create(req: Request, res: Response) {
    const { startTime, endTime } = req.body;

    if (endTime <= startTime) {
      throw new BadRequest(
        `Reservation end time (${endTime}) should occur after start time (${startTime}).`,
      );
    }

    const reservationId = this.dependencies.reservationService.create(req.body);

    return res.status(StatusCodes.CREATED).json({ reservationId });
  }

  search(req: Request, res: Response) {
    const { limit = 500, cursor = null, startTime, endTime, owner, room } = req.query;

    const search = {} as ReservationQuery;

    if (startTime) {
      search.startTime = Number(startTime);
    }

    if (endTime) {
      search.endTime = Number(endTime);
    }

    if (owner) {
      search.owner = String(owner);
    }

    if (room) {
      search.room = String(room);
    }

    const pagination = {
      limit: Number(limit),
      cursor,
    } as Pagination;

    const results = this.dependencies.reservationService.search(search, pagination);

    return res.status(StatusCodes.OK).json(results);
  }

  getById(req: Request, res: Response) {
    const { reservationId } = req.params;

    const reservation = this.dependencies.reservationService.get(reservationId as string);

    return res.status(StatusCodes.OK).json(reservation);
  }

  update(req: Request, res: Response) {
    const { reservationId } = req.params;

    const { startTime, endTime } = req.body;

    if (endTime && startTime && Number(endTime) <= Number(startTime)) {
      throw new BadRequest(
        `Reservation end time (${endTime}) should occur after start time (${startTime}).`,
      );
    }

    const reservation = this.dependencies.reservationService.update(
      reservationId as string,
      req.body,
    );

    return res.status(StatusCodes.OK).json(reservation);
  }

  delete(req: Request, res: Response) {
    const { reservationId } = req.params;

    this.dependencies.reservationService.delete(reservationId as string);

    return res.status(StatusCodes.NO_CONTENT).send();
  }
}
