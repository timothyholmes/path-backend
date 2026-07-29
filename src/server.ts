import express, { Router, Request, Response, NextFunction } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import swaggerUi from 'swagger-ui-express';
import YAML from 'js-yaml';
import fs from 'fs';
import { ServerError } from './errors/serverError';

interface ServerConfig {
  server: {
    port?: number;
  };
}

class Server<Config extends ServerConfig, Dependencies> {
  PORT: number;
  app: express.Application;
  config: Config;
  dependencies?: Dependencies;

  constructor(config: Config) {
    this.app = express();
    this.PORT = config.server.port || 3000;
    this.config = config;
    this.app.use(express.json());
    this.dependencies = {} as Dependencies;
  }

  start() {
    this.app.listen(this.PORT, () => {
      console.log(`Server running on port ${this.PORT}`);
    });
  }

  withDependencies(
    getDependencies: (config: Config, overrides: Partial<Dependencies>) => Dependencies,
    overrides: Partial<Dependencies> = {},
  ) {
    this.dependencies = getDependencies(this.config, overrides);

    return this;
  }

  withOpenApiSpec(specPath: string) {
    const spec = YAML.load(fs.readFileSync(specPath, 'utf8')) as object;

    this.app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));

    this.app.use(
      OpenApiValidator.middleware({
        apiSpec: specPath,
        validateRequests: true,
        validateResponses: true,
      }),
    );

    return this;
  }

  withRouters(getRouters: (config: Config, dependencies: Dependencies) => Router[]): this {
    if (!this.dependencies) {
      throw new Error('Dependencies must be set before adding routers.');
    }

    const routers = getRouters(this.config, this.dependencies);

    routers.forEach((router) => {
      this.app.use(router);
    });

    this.app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof ServerError) {
        res.status(err.code).json({ error: err.type, message: err.message });
      } else if (
        err &&
        typeof err === 'object' &&
        'status' in err &&
        typeof (err as { status: unknown }).status === 'number'
      ) {
        const httpErr = err as { status: number; message: string };
        res.status(httpErr.status).json({ error: httpErr.message, message: httpErr.message });
      } else {
        res
          .status(500)
          .json({ error: 'Internal Server Error', message: 'An unexpected error occurred' });
      }
    });

    return this;
  }
}

export default Server;
