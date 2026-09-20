import { StatusCodes } from 'http-status-codes';
import { Request, Response } from 'express';
import { Config, Dependencies } from '../../config';
import { AuthenticatedUser } from '../../auth/types';
import { VirtueCreateInput, VirtueHistoryQuery, VirtueUpdateInput } from '../../types';
import { BadRequest } from '../../errors/badRequest';

export class VirtueRouter {
  config: Config;
  dependencies: Dependencies;

  constructor(config: Config, dependencies: Dependencies) {
    this.config = config;
    this.dependencies = dependencies;
  }

  async list(req: Request, res: Response) {
    const userId = this.userId(req);

    const virtues = await this.dependencies.virtueService.list(userId);

    return res.status(StatusCodes.OK).json(virtues);
  }

  async create(req: Request, res: Response) {
    const userId = this.userId(req);
    const { name, icon, color, display_order } = req.body;

    const input: VirtueCreateInput = {
      name,
      ...(icon !== undefined && { icon }),
      ...(color !== undefined && { color }),
      ...(display_order !== undefined && { display_order }),
    };

    const virtue = await this.dependencies.virtueService.create(userId, input);

    return res.status(StatusCodes.CREATED).json(virtue);
  }

  async update(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;
    const { name, icon, color, display_order } = req.body;

    // Only fields actually present in the body are forwarded, so an omitted
    // field leaves the column untouched. `xp` and `level` are absent from
    // VirtueUpdate by design — they are derived from the ledger — so anything
    // the client sends for them is dropped here rather than reaching a column.
    const patch: VirtueUpdateInput = {
      ...(name !== undefined && { name }),
      ...(icon !== undefined && { icon }),
      ...(color !== undefined && { color }),
      ...(display_order !== undefined && { display_order }),
    };

    const virtue = await this.dependencies.virtueService.update(userId, id as string, patch);

    return res.status(StatusCodes.OK).json(virtue);
  }

  async delete(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;

    await this.dependencies.virtueService.delete(userId, id as string);

    return res.status(StatusCodes.NO_CONTENT).send();
  }

  async history(req: Request, res: Response) {
    const userId = this.userId(req);
    const { id } = req.params;
    const { from, to } = req.query;

    // Both bounds are inclusive, so an inverted window is empty by definition
    // rather than merely unusual — and the OpenAPI schema cannot relate two
    // parameters to each other.
    if (from !== undefined && to !== undefined && (from as string) > (to as string)) {
      throw new BadRequest('from must not be later than to.');
    }

    const query: VirtueHistoryQuery = {
      ...(from !== undefined && { from: from as string }),
      ...(to !== undefined && { to: to as string }),
    };

    const history = await this.dependencies.virtueService.history(userId, id as string, query);

    return res.status(StatusCodes.OK).json(history);
  }

  // `requireAuth` is mounted ahead of every virtue route (see src/routers.ts)
  // and either sets req.auth or short-circuits the request with 401, so it is
  // always present by the time a handler runs.
  private userId(req: Request): string {
    return (req.auth as AuthenticatedUser).userId;
  }
}
