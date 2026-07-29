import path from 'path';
import request from 'supertest';
import Server from '../src/server';
import { Config, Dependencies, getConfig } from '../src/config';
import { getDependencies } from '../src/dependencies';
import { getRouters } from '../src/routers';

const API_SPEC = path.resolve(__dirname, '../api-spec.yml');

export function createTestApp() {
  const server = new Server<Config, Dependencies>(getConfig());
  server.withOpenApiSpec(API_SPEC).withDependencies(getDependencies).withRouters(getRouters);
  return request(server.app);
}
