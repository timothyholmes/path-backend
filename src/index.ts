import { getConfig, Config, Dependencies } from './config';
import { getDependencies } from './dependencies';
import { getRouters } from './routers';
import Server from './server';

const server = new Server<Config, Dependencies>(getConfig());

server
  .withOpenApiSpec('./api-spec.yml')
  .withDependencies(getDependencies)
  .withRouters(getRouters)
  .start();
