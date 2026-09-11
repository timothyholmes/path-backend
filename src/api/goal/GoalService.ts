import { Config, Dependencies } from '../../config';
import Storage from './GoalStorage';
import {
  BacklogItem,
  BacklogItemCreateInput,
  BacklogItemUpdateInput,
  BacklogPromoteInput,
  Goal,
  GoalCreateInput,
  GoalListQuery,
  GoalUpdateInput,
  ScoringResult,
} from '../../types';

class GoalService {
  config: Config;
  storage: Storage;
  logger: Console;

  constructor(config: Config, dependencies: Pick<Dependencies, 'goalStorage' | 'logger'>) {
    this.config = config;
    this.storage = dependencies.goalStorage;
    this.logger = dependencies.logger;
  }

  list(userId: string, query: GoalListQuery): Promise<Goal[]> {
    return this.storage.list(userId, query);
  }

  create(userId: string, input: GoalCreateInput): Promise<Goal> {
    return this.storage.create(userId, input);
  }

  update(userId: string, goalId: string, patch: GoalUpdateInput): Promise<Goal> {
    return this.storage.update(userId, goalId, patch);
  }

  delete(userId: string, goalId: string): Promise<void> {
    return this.storage.delete(userId, goalId);
  }

  complete(userId: string, goalId: string): Promise<ScoringResult> {
    return this.storage.complete(userId, goalId);
  }

  listBacklog(userId: string): Promise<BacklogItem[]> {
    return this.storage.listBacklog(userId);
  }

  createBacklogItem(userId: string, input: BacklogItemCreateInput): Promise<BacklogItem> {
    return this.storage.createBacklogItem(userId, input);
  }

  updateBacklogItem(
    userId: string,
    itemId: string,
    patch: BacklogItemUpdateInput,
  ): Promise<BacklogItem> {
    return this.storage.updateBacklogItem(userId, itemId, patch);
  }

  deleteBacklogItem(userId: string, itemId: string): Promise<void> {
    return this.storage.deleteBacklogItem(userId, itemId);
  }

  promoteBacklogItem(
    userId: string,
    itemId: string,
    overrides: BacklogPromoteInput,
  ): Promise<Goal> {
    return this.storage.promoteBacklogItem(userId, itemId, overrides);
  }
}

export default GoalService;
