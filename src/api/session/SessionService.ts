import { Config, Dependencies } from '../../config';
import Storage from './SessionStorage';
import {
  ScoringResult,
  Session,
  SessionCreateInput,
  SessionListQuery,
  SessionUpdateInput,
  TimerState,
} from '../../types';

class SessionService {
  config: Config;
  storage: Storage;
  logger: Console;

  constructor(config: Config, dependencies: Pick<Dependencies, 'sessionStorage' | 'logger'>) {
    this.config = config;
    this.storage = dependencies.sessionStorage;
    this.logger = dependencies.logger;
  }

  list(userId: string, query: SessionListQuery): Promise<Session[]> {
    return this.storage.list(userId, query);
  }

  create(userId: string, input: SessionCreateInput): Promise<Session> {
    return this.storage.create(userId, input);
  }

  update(userId: string, sessionId: string, patch: SessionUpdateInput): Promise<Session> {
    return this.storage.update(userId, sessionId, patch);
  }

  delete(userId: string, sessionId: string): Promise<void> {
    return this.storage.delete(userId, sessionId);
  }

  start(userId: string, sessionId: string, focusModeActivated: boolean): Promise<TimerState> {
    return this.storage.start(userId, sessionId, focusModeActivated);
  }

  end(userId: string, sessionId: string, actualDurationSeconds?: number): Promise<ScoringResult> {
    return this.storage.end(userId, sessionId, actualDurationSeconds);
  }

  skip(userId: string, sessionId: string): Promise<ScoringResult> {
    return this.storage.skip(userId, sessionId);
  }
}

export default SessionService;
