import { Config, Dependencies } from '../../config';
import Storage from './VirtueStorage';
import {
  Virtue,
  VirtueCreateInput,
  VirtueHistory,
  VirtueHistoryQuery,
  VirtueUpdateInput,
} from '../../types';

class VirtueService {
  config: Config;
  storage: Storage;
  logger: Console;

  constructor(config: Config, dependencies: Pick<Dependencies, 'virtueStorage' | 'logger'>) {
    this.config = config;
    this.storage = dependencies.virtueStorage;
    this.logger = dependencies.logger;
  }

  list(userId: string): Promise<Virtue[]> {
    return this.storage.list(userId);
  }

  create(userId: string, input: VirtueCreateInput): Promise<Virtue> {
    return this.storage.create(userId, input);
  }

  update(userId: string, virtueId: string, patch: VirtueUpdateInput): Promise<Virtue> {
    return this.storage.update(userId, virtueId, patch);
  }

  delete(userId: string, virtueId: string): Promise<void> {
    return this.storage.delete(userId, virtueId);
  }

  history(userId: string, virtueId: string, query: VirtueHistoryQuery): Promise<VirtueHistory> {
    return this.storage.history(userId, virtueId, query);
  }
}

export default VirtueService;
