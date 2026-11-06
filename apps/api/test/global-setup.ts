import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { TEST_TERMS_VERSION, resolveTestDatabaseUrl } from './test-database';

/** Applies migrations to the dedicated test database before the suite runs. */
export default function globalSetup(): void {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: resolveTestDatabaseUrl() },
    stdio: 'inherit',
  });
  // Test-database fixture only: suites written before the terms-of-use gate
  // (ADR-0022) create accounts that have accepted the CI terms version.
  // access.e2e-spec clears these columns to exercise the gate itself.
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'db', 'execute', '--stdin', '--url', resolveTestDatabaseUrl()],
    {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: resolveTestDatabaseUrl() },
      input: `ALTER TABLE "users" ALTER COLUMN "terms_accepted_version" SET DEFAULT '${TEST_TERMS_VERSION}', ALTER COLUMN "terms_accepted_at" SET DEFAULT CURRENT_TIMESTAMP;`,
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );
}
