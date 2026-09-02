import path from 'path';
import request from 'supertest';
import Server from '../../../src/server';
import { Config, Dependencies, getConfig } from '../../../src/config';
import { getDependencies } from '../../../src/dependencies';
import { getRouters } from '../../../src/routers';
import { signTestToken, withAuth, TestAgent } from '../../helpers';

const API_SPEC = path.resolve(__dirname, '../../../api-spec.yml');

export interface RoutineTestApp {
  agent: TestAgent;
  /** Same server, no bearer token attached — for asserting on 401s. */
  unauthenticatedAgent: TestAgent;
  dependencies: Dependencies;
}

/**
 * Builds a full `Server` (with the real OpenAPI validator and routers) pointed
 * at `databaseUrl` — a migrated temp database from `test/db/helpers.ts` — and
 * authenticated as `userId`. The routine module is the first Postgres-backed
 * resource, so it needs a real database rather than the in-memory storage the
 * reservation/availability tests use.
 *
 * Callers must `dependencies.pool.end()` at teardown; the pool is only
 * released here, not on the temp database's own drop.
 */
export function createRoutineTestApp(databaseUrl: string, userId: string): RoutineTestApp {
  const base = getConfig();
  const config: Config = { ...base, database: { ...base.database, url: databaseUrl } };

  const server = new Server<Config, Dependencies>(config);
  server.withOpenApiSpec(API_SPEC).withDependencies(getDependencies).withRouters(getRouters);

  const dependencies = server.dependencies as Dependencies;
  const agent = withAuth(request(server.app), signTestToken({ sub: userId }));
  const unauthenticatedAgent = request(server.app);

  return { agent, unauthenticatedAgent, dependencies };
}
