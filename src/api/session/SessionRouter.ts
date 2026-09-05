import { StatusCodes } from 'http-status-codes';
import { Request, Response } from 'express';
import { Config, Dependencies } from '../../config';
import { AuthenticatedUser } from '../../auth/types';
import { SessionCreateInput, SessionListQuery, SessionUpdateInput } from '../../types';

export class SessionRouter {
  config: Config;
  dependencies: Dependencies;

  constructor(config: Config, dependencies: Dependencies) {
    this.config = config;
    this.dependencies = dependencies;
  }

  async list(req: Request, res: Response) {
    const userId = this.userId(req);
    const { is_active } = req.query;

    const query: SessionListQuery = {};
    if (is_active !== undefined) {
      query.isActive = is_active === 'true';
    }

    const sessions = await this.dependencies.sessionService.list(userId, query);

    return res.status(StatusCodes.OK).json(sessions);
  }

  async create(req: Request, res: Response) {
    const userId = this.userId(req);
    const { title, target_duration_minutes, recurrence_rule, base_xp, virtue_ids } = req.body;

    const input: SessionCreateInput = {
      title,
      target_duration_minutes,
      virtue_ids,
      ...(recurrence_rule !== undefined && { recurrence_rule }),
      ...(base_xp !== undefined && { base_xp }),
    };

    const session = await this.dependencies.sessionService.create(userId, input);

    return res.status(StatusCodes.CREATED).json(session);
  }

  async update(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;
    const { title, target_duration_minutes, recurrence_rule, base_xp, is_active, virtue_ids } =
      req.body;

    // Only fields actually present in the body are forwarded, so an omitted
    // field leaves the column untouched; `recurrence_rule` may be explicitly
    // `null` per SessionUpdate, which the spreads below preserve.
    const patch: SessionUpdateInput = {
      ...(title !== undefined && { title }),
      ...(target_duration_minutes !== undefined && { target_duration_minutes }),
      ...(recurrence_rule !== undefined && { recurrence_rule }),
      ...(base_xp !== undefined && { base_xp }),
      ...(is_active !== undefined && { is_active }),
      ...(virtue_ids !== undefined && { virtue_ids }),
    };

    const session = await this.dependencies.sessionService.update(userId, id as string, patch);

    return res.status(StatusCodes.OK).json(session);
  }

  async delete(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;

    await this.dependencies.sessionService.delete(userId, id as string);

    return res.status(StatusCodes.NO_CONTENT).send();
  }

  async start(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;
    const { focus_mode_activated } = req.body ?? {};

    const timer = await this.dependencies.sessionService.start(
      userId,
      id as string,
      focus_mode_activated ?? false,
    );

    return res.status(StatusCodes.OK).json(timer);
  }

  async end(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;
    const { actual_duration_seconds } = req.body ?? {};

    const result = await this.dependencies.sessionService.end(
      userId,
      id as string,
      actual_duration_seconds,
    );

    return res.status(StatusCodes.OK).json(result);
  }

  async skip(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;

    const result = await this.dependencies.sessionService.skip(userId, id as string);

    return res.status(StatusCodes.OK).json(result);
  }

  // `requireAuth` is mounted ahead of every session route (see src/routers.ts)
  // and either sets req.auth or short-circuits the request with 401, so it is
  // always present by the time a handler runs.
  private userId(req: Request): string {
    return (req.auth as AuthenticatedUser).userId;
  }
}
