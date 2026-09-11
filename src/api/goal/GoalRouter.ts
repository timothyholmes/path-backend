import { StatusCodes } from 'http-status-codes';
import { Request, Response } from 'express';
import { Config, Dependencies } from '../../config';
import { AuthenticatedUser } from '../../auth/types';
import {
  BacklogItemCreateInput,
  BacklogItemUpdateInput,
  BacklogPromoteInput,
  GoalCreateInput,
  GoalListQuery,
  GoalStatus,
  GoalUpdateInput,
} from '../../types';
import { BadRequest } from '../../errors/badRequest';

export class GoalRouter {
  config: Config;
  dependencies: Dependencies;

  constructor(config: Config, dependencies: Dependencies) {
    this.config = config;
    this.dependencies = dependencies;
  }

  async list(req: Request, res: Response) {
    const userId = this.userId(req);
    const { status, is_quest, parent_goal_id } = req.query;

    const query: GoalListQuery = {};
    if (status !== undefined) {
      query.status = status as GoalStatus;
    }
    if (is_quest !== undefined) {
      query.isQuest = is_quest === 'true';
    }
    if (parent_goal_id !== undefined) {
      query.parentGoalId = parent_goal_id as string;
    }

    const goals = await this.dependencies.goalService.list(userId, query);

    return res.status(StatusCodes.OK).json(goals);
  }

  async create(req: Request, res: Response) {
    const userId = this.userId(req);
    const { title, description, is_quest, status, due_date, base_xp, parent_goal_id, virtue_ids } =
      req.body;

    const input: GoalCreateInput = {
      title,
      ...(description !== undefined && { description }),
      ...(is_quest !== undefined && { is_quest }),
      ...(status !== undefined && { status }),
      ...(due_date !== undefined && { due_date }),
      ...(base_xp !== undefined && { base_xp }),
      ...(parent_goal_id !== undefined && { parent_goal_id }),
      ...(virtue_ids !== undefined && { virtue_ids }),
    };

    const goal = await this.dependencies.goalService.create(userId, input);

    return res.status(StatusCodes.CREATED).json(goal);
  }

  async update(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;
    const { title, description, is_quest, status, due_date, display_order, virtue_ids } = req.body;

    // Only fields actually present in the body are forwarded, so an omitted
    // field leaves the column untouched; `due_date` may be explicitly `null`
    // per GoalUpdate, which the spreads below preserve.
    const patch: GoalUpdateInput = {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(is_quest !== undefined && { is_quest }),
      ...(status !== undefined && { status }),
      ...(due_date !== undefined && { due_date }),
      ...(display_order !== undefined && { display_order }),
      ...(virtue_ids !== undefined && { virtue_ids }),
    };

    const goal = await this.dependencies.goalService.update(userId, id as string, patch);

    return res.status(StatusCodes.OK).json(goal);
  }

  async delete(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;

    await this.dependencies.goalService.delete(userId, id as string);

    return res.status(StatusCodes.NO_CONTENT).send();
  }

  async complete(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;

    const result = await this.dependencies.goalService.complete(userId, id as string);

    return res.status(StatusCodes.OK).json(result);
  }

  async listBacklog(req: Request, res: Response) {
    const userId = this.userId(req);

    const items = await this.dependencies.goalService.listBacklog(userId);

    return res.status(StatusCodes.OK).json(items);
  }

  async createBacklogItem(req: Request, res: Response) {
    const userId = this.userId(req);
    const { title, notes, source, source_id, virtue_id } = req.body;

    // `source_id` points at a field log or retrospective depending on `source`,
    // so it is not a foreign key and nothing else will catch it dangling on a
    // `manual` idea (BacklogItem.source_id, api-spec.yml).
    if (source_id !== undefined && (source ?? 'manual') === 'manual') {
      throw new BadRequest(
        'source_id is only meaningful when source is ai_suggestion or field_log.',
      );
    }

    const input: BacklogItemCreateInput = {
      title,
      ...(notes !== undefined && { notes }),
      ...(source !== undefined && { source }),
      ...(source_id !== undefined && { source_id }),
      ...(virtue_id !== undefined && { virtue_id }),
    };

    const item = await this.dependencies.goalService.createBacklogItem(userId, input);

    return res.status(StatusCodes.CREATED).json(item);
  }

  async updateBacklogItem(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;
    const { title, notes, virtue_id } = req.body;

    const patch: BacklogItemUpdateInput = {
      ...(title !== undefined && { title }),
      ...(notes !== undefined && { notes }),
      ...(virtue_id !== undefined && { virtue_id }),
    };

    const item = await this.dependencies.goalService.updateBacklogItem(userId, id as string, patch);

    return res.status(StatusCodes.OK).json(item);
  }

  async deleteBacklogItem(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;

    await this.dependencies.goalService.deleteBacklogItem(userId, id as string);

    return res.status(StatusCodes.NO_CONTENT).send();
  }

  async promoteBacklogItem(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;
    const { is_quest, due_date, base_xp } = req.body ?? {};

    const overrides: BacklogPromoteInput = {
      ...(is_quest !== undefined && { is_quest }),
      ...(due_date !== undefined && { due_date }),
      ...(base_xp !== undefined && { base_xp }),
    };

    const goal = await this.dependencies.goalService.promoteBacklogItem(
      userId,
      id as string,
      overrides,
    );

    return res.status(StatusCodes.CREATED).json(goal);
  }

  // `requireAuth` is mounted ahead of every goal route (see src/routers.ts) and
  // either sets req.auth or short-circuits the request with 401, so it is
  // always present by the time a handler runs.
  private userId(req: Request): string {
    return (req.auth as AuthenticatedUser).userId;
  }
}
