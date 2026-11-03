import { resolveTestDatabaseUrl } from './test-database';

process.env.NODE_ENV = 'test';
process.env.DEPLOY_ENV = 'ci';
process.env.DATABASE_URL = resolveTestDatabaseUrl();
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.CSRF_SECRET = 'integration-test-csrf-secret-0123456789';
process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.SESSION_COOKIE_SECURE = 'false';
process.env.MAIL_TRANSPORT = 'memory';
process.env.LOG_LEVEL = 'silent';
process.env.TRUST_PROXY_HOPS = '1';
process.env.LOGIN_MAX_FAILED_ATTEMPTS = '3';
process.env.RATE_LIMIT_AUTH_PER_MINUTE = '20';
process.env.RATE_LIMIT_DEFAULT_PER_MINUTE = '600';
