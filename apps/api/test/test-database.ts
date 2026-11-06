/**
 * Integration tests must never touch a non-test database. The database name
 * must contain "test"; anything else aborts the run.
 */
export function resolveTestDatabaseUrl(): string {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://exchange:exchange_dev_password@localhost:5432/exchange_test';
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run integration tests against database "${dbName}" (name must contain "test")`,
    );
  }
  return url;
}

/** Terms-of-use version used by the integration suites (ADR-0022). */
export const TEST_TERMS_VERSION = 'ci-terms-1';
