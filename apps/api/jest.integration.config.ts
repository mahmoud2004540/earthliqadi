import type { Config } from 'jest';

/**
 * Integration tests run against real PostgreSQL and Redis instances
 * (DATABASE_URL / REDIS_URL). They are never run against shared or
 * production databases: test/setup-env.ts refuses non-test database names.
 */
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testTimeout: 30000,
};

export default config;
