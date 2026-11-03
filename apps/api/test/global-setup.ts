import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { resolveTestDatabaseUrl } from './test-database';

/** Applies migrations to the dedicated test database before the suite runs. */
export default function globalSetup(): void {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: resolveTestDatabaseUrl() },
    stdio: 'inherit',
  });
}
