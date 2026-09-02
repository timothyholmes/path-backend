import { Config, Dependencies } from '../../config';
import Storage from './RoutineStorage';
import { Routine, RoutineCreateInput, RoutineListQuery, ScoringResult } from '../../types';

class RoutineService {
  config: Config;
  storage: Storage;
  logger: Console;

  constructor(config: Config, dependencies: Pick<Dependencies, 'routineStorage' | 'logger'>) {
    this.config = config;
    this.storage = dependencies.routineStorage;
    this.logger = dependencies.logger;
  }

  list(userId: string, query: RoutineListQuery): Promise<Routine[]> {
    return this.storage.list(userId, query);
  }

  create(userId: string, input: RoutineCreateInput): Promise<Routine> {
    return this.storage.create(userId, input);
  }

  complete(userId: string, routineId: string, completedAt?: string): Promise<ScoringResult> {
    return this.storage.complete(userId, routineId, completedAt);
  }
}

export default RoutineService;
