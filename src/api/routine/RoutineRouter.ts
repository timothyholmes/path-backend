import { StatusCodes } from 'http-status-codes';
import { Config, Dependencies } from '../../config';
import { Request, Response } from 'express';
import { AuthenticatedUser } from '../../auth/types';
import {
  RoutineCreateInput,
  RoutineFrequency,
  RoutineListQuery,
  RoutineUpdateInput,
} from '../../types';
import { BadRequest } from '../../errors/badRequest';

export class RoutineRouter {
  config: Config;
  dependencies: Dependencies;

  constructor(config: Config, dependencies: Dependencies) {
    this.config = config;
    this.dependencies = dependencies;
  }

  async list(req: Request, res: Response) {
    const userId = this.userId(req);
    const { is_active, frequency } = req.query;

    const query: RoutineListQuery = {};
    if (is_active !== undefined) {
      query.isActive = is_active === 'true';
    }
    if (frequency !== undefined) {
      query.frequency = frequency as RoutineFrequency;
    }

    const routines = await this.dependencies.routineService.list(userId, query);

    return res.status(StatusCodes.OK).json(routines);
  }

  async create(req: Request, res: Response) {
    const userId = this.userId(req);
    const { title, description, frequency, scheduled_day, base_xp, virtue_ids } = req.body;

    // `scheduled_day`'s requiredness depends on `frequency`, which the OpenAPI
    // schema can only document in prose (RoutineCreate.scheduled_day
    // description), not enforce.
    if (frequency === 'daily' && scheduled_day !== undefined) {
      throw new BadRequest('scheduled_day must be omitted for a daily routine.');
    }
    if (frequency !== 'daily' && scheduled_day === undefined) {
      throw new BadRequest(`scheduled_day is required for a ${frequency} routine.`);
    }

    const input: RoutineCreateInput = {
      title,
      frequency,
      virtue_ids,
      ...(description !== undefined && { description }),
      ...(scheduled_day !== undefined && { scheduled_day }),
      ...(base_xp !== undefined && { base_xp }),
    };

    const routine = await this.dependencies.routineService.create(userId, input);

    return res.status(StatusCodes.CREATED).json(routine);
  }

  async update(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;
    const { title, description, frequency, scheduled_day, base_xp, is_active, virtue_ids } =
      req.body;

    // Only fields actually present in the body are forwarded, so an omitted
    // field leaves the column untouched; `description`/`scheduled_day` may be
    // explicitly `null` per RoutineUpdate, which the spreads below preserve.
    const patch: RoutineUpdateInput = {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(frequency !== undefined && { frequency }),
      ...(scheduled_day !== undefined && { scheduled_day }),
      ...(base_xp !== undefined && { base_xp }),
      ...(is_active !== undefined && { is_active }),
      ...(virtue_ids !== undefined && { virtue_ids }),
    };

    const routine = await this.dependencies.routineService.update(userId, id as string, patch);

    return res.status(StatusCodes.OK).json(routine);
  }

  async delete(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;

    await this.dependencies.routineService.delete(userId, id as string);

    return res.status(StatusCodes.NO_CONTENT).send();
  }

  async complete(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;
    const { completed_at } = req.body ?? {};

    const result = await this.dependencies.routineService.complete(
      userId,
      id as string,
      completed_at,
    );

    return res.status(StatusCodes.OK).json(result);
  }

  // `requireAuth` is mounted ahead of every routine route (see src/routers.ts)
  // and either sets req.auth or short-circuits the request with 401, so it is
  // always present by the time a handler runs.
  private userId(req: Request): string {
    return (req.auth as AuthenticatedUser).userId;
  }
}
