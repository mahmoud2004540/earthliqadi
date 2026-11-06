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
process.env.LOG_LEVEL = process.env.TEST_LOGS ? 'error' : 'silent';
process.env.TRUST_PROXY_HOPS = '1';
process.env.LOGIN_MAX_FAILED_ATTEMPTS = '3';
process.env.RATE_LIMIT_AUTH_PER_MINUTE = '20';
process.env.RATE_LIMIT_DEFAULT_PER_MINUTE = '600';
process.env.LEDGER_RECONCILIATION_INTERVAL_SECONDS = '0';
process.env.SETTLEMENT_POLL_MS = '0';
process.env.PERP_RISK_POLL_MS = '0';
process.env.CANCEL_TIMER_POLL_MS = '0';
process.env.GROWTH_JOB_INTERVAL_SECONDS = '0';
process.env.ALGO_POLL_MS = '0';
// Most suites exercise staff endpoints without MFA; admin.e2e-spec turns enforcement on.
process.env.STAFF_MFA_REQUIRED = 'false';
// The KYC module is off by default (ADR-0013); its suite exercises it enabled.
process.env.KYC_ENABLED = 'true';
process.env.MARKET_DATA_POLL_MS = '50';
