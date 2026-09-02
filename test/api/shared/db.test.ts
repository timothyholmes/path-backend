import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDbPool } from '../../../src/api/shared/db';
import { Config } from '../../../src/config';

function baseConfig(): Config {
  return {
    server: { port: 3000 },
    auth: { jwtSecret: 'test-secret' },
  };
}

describe('createDbPool', () => {
  it('builds a pool from database.url, applying default poolMax and statementTimeoutMs', () => {
    const config = {
      ...baseConfig(),
      database: { url: 'postgresql://user:pass@localhost:5432/db' },
    };

    const pool = createDbPool(config);
    try {
      expect(pool).toBeInstanceOf(Pool);
      expect(pool.options.max).toBe(10);
      expect(pool.options.statement_timeout).toBe(30_000);
    } finally {
      void pool.end();
    }
  });

  it('honours explicit poolMax and statementTimeoutMs overrides', () => {
    const config = {
      ...baseConfig(),
      database: {
        url: 'postgresql://user:pass@localhost:5432/db',
        poolMax: 3,
        statementTimeoutMs: 5_000,
      },
    };

    const pool = createDbPool(config);
    try {
      expect(pool.options.max).toBe(3);
      expect(pool.options.statement_timeout).toBe(5_000);
    } finally {
      void pool.end();
    }
  });

  it('throws when database.url is not configured', () => {
    expect(() => createDbPool(baseConfig())).toThrow(/database\.url must be configured/);
  });

  it('throws when database config is present but url is missing', () => {
    const config = { ...baseConfig(), database: {} };
    expect(() => createDbPool(config)).toThrow(/database\.url must be configured/);
  });
});
