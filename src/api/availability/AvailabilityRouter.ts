import { StatusCodes } from 'http-status-codes';
import { Config, Dependencies } from '../../config';
import { Request, Response } from 'express';
import { AvailabilityQuery, Pagination } from '../../types';
import { BadRequest } from '../../errors/badRequest';

export class AvailabilityRouter {
  config: Config;
  dependencies: Dependencies;

  constructor(config: Config, dependencies: Dependencies) {
    this.config = config;
    this.dependencies = dependencies;
  }

  search(req: Request, res: Response) {
    const { limit = 500, cursor = null, startTime, endTime } = req.query;

    const availabilityQuery = {
      startTime: Number(startTime),
      endTime: Number(endTime),
    } as AvailabilityQuery;

    if (availabilityQuery.endTime <= availabilityQuery.startTime) {
      throw new BadRequest(
        `Reservation end time (${availabilityQuery.endTime}) should occur after start time (${availabilityQuery.startTime}).`,
      );
    }

    const pagination = {
      limit: Number(limit),
      cursor,
    } as Pagination;

    const results = this.dependencies.availabilityService.search(availabilityQuery, pagination);

    return res.status(StatusCodes.OK).json(results);
  }
}
