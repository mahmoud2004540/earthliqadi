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
- `e2e/`: Playwright browser tests against the Compose stack (`pnpm test:e2e`, CI job `e2e`). Each run creates its own market for isolation.
- `load/order-flow.mjs`: order-flow load measurement (see `docs/operations/performance.md`)
