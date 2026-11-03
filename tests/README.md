# Tests

Tests currently live next to the code they test:

| Kind                           | Location                      | Runner | Command                 |
| ------------------------------ | ----------------------------- | ------ | ----------------------- |
| Unit (shared, config)          | `packages/*/src/**/*.test.ts` | Vitest | `pnpm test`             |
| Unit (web: i18n, locale)       | `apps/web/src/**/*.test.ts`   | Vitest | `pnpm test`             |
| Unit (API)                     | `apps/api/src/**/*.spec.ts`   | Jest   | `pnpm test`             |
| Integration (API + PG + Redis) | `apps/api/test/*.e2e-spec.ts` | Jest   | `pnpm test:integration` |

This top-level directory is reserved for cross-application suites:

- `integration/`: multi-service tests (e.g. ledger ↔ matching engine, Phase 3+)
- `e2e/`: browser tests (Playwright) against the Compose stack, to be added to CI
