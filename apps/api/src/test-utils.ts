import { loadAppConfig, type AppConfig } from './config/app-config';

/** Minimal valid config for unit tests (no network access needed). */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadAppConfig({
    NODE_ENV: 'test',
    DEPLOY_ENV: 'ci',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/unit_test',
    REDIS_URL: 'redis://localhost:6379',
    WEB_ORIGIN: 'http://localhost:3000',
    CSRF_SECRET: 'unit-test-csrf-secret-0123456789abcdef',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    SESSION_COOKIE_SECURE: 'false',
    MAIL_TRANSPORT: 'memory',
    ...overrides,
  });
}
