# Delivery roadmap

Phases are sequential. A phase is complete only when its acceptance criteria,
tests, security review and documentation are done.

| Phase | Scope                                                      | Status       |
| ----- | ---------------------------------------------------------- | ------------ |
| 0     | Architecture and repository foundation                     | **Complete** |
| 1     | Frontend, backend, authentication, database, Docker, CI    | **Complete** |
| 2     | Financial ledger and accounting                            | **Complete** |
| 3     | Spot matching engine (Rust)                                | **Complete** |
| 4     | Market data and professional trading terminal              | **Complete** |
| 5     | Spot paper trading and simulation                          | Next         |
| 6     | Perpetual futures and risk simulation                      | Planned      |
| 7     | Admin, compliance and monitoring                           | Planned      |
| 8     | Custody and liquidity integrations                         | Planned      |
| 9     | Security audits and regulatory readiness                   | Planned      |
| 10    | Controlled production launch, after all required approvals | Planned      |

## Phase 0 + 1 acceptance criteria (Sprint 1)

- [x] pnpm monorepo with shared packages and pinned dependencies
- [x] Environment validation that refuses unsafe staging/production configuration
- [x] PostgreSQL schema with migrations, DB-level constraints and an append-only audit trigger
- [x] Registration, email verification, login, logout, password reset and change
- [x] Server-side sessions with idle/absolute expiry, device listing and revocation
- [x] TOTP MFA with encrypted secrets and replay protection
- [x] RBAC catalogue, permission guard and audited role grants (CLI bootstrap, no default admin)
- [x] CSRF protection, rate limiting, account lockout, security headers
- [x] Health endpoints (liveness, readiness)
- [x] Responsive bilingual (EN/AR, LTR/RTL) web app with public, auth and dashboard pages _(Arabic later removed: ADR-0008)_
- [x] Unit and integration tests against real PostgreSQL and Redis
- [x] Docker images, Compose stack with an edge proxy, CI pipeline, dependency audit
- [x] Architecture, ADR, security, API and operations documentation

## Phase 2 acceptance criteria (Sprint 2)

- [x] ADR for amounts, chart of accounts, posting algorithm, corrections and reconciliation ([ADR-0006](../decisions/0006-double-entry-ledger.md))
- [x] Integer minor units in `NUMERIC(38,0)` / `bigint`; exact decimal parsing that never rounds (property-tested)
- [x] Asset registry with immutable code and scale; enable/disable; audited configuration
- [x] Journal entries and postings, balanced per asset, enforced by a deferred database constraint
- [x] Immutable journal, postings and reconciliation runs; balances change only through postings (DB triggers)
- [x] Non-negative balances, enforced by an application pre-check and a database CHECK
- [x] Deterministic lock order (no deadlocks); idempotency keys with request fingerprints
- [x] Holds and releases (available ↔ locked) ready for the order system
- [x] Reversals as the only correction mechanism; at most one reversal per entry
- [x] Reconciliation (projection, per-entry balance, trial balance, negative balances): scheduled, manual and CLI; append-only results
- [x] User balances and history API and dashboard; staff read API with audited access
- [x] Simulated deposits for development only, refused outside `local`/`ci`
- [x] Tests: property-based, concurrency, idempotency races, DB invariants, reconciliation tamper detection

## Phase 3 acceptance criteria (Sprint 3)

- [x] ADR for engine boundaries, protocol, transport, units, matching rules, state machine, fees, recovery ([ADR-0007](../decisions/0007-matching-engine.md))
- [x] Market registry (tick/lot sizes in minor units, divisibility enforced, immutable units, fees, halt/resume), audited
- [x] Rust engine: price-time priority; limit, market (protection price), stop-limit and stop-market; GTC/IOC/FOK/post-only; partial fills; cancel; quantity reduction keeping priority; self-trade prevention
- [x] Determinism: no clocks or randomness in the library; SHA-256 chain over commands and events; startup replay verification (refuses to run on mismatch)
- [x] Durable, gap-free command log written atomically with the fund hold; immutable event log; exactly-once offsets
- [x] Settlement: one balanced multi-asset `TRADE` entry per fill, fees to `FEE_REVENUE`, releases on cancel/fill/reduce, order state machine enforced
- [x] Order API (place, cancel, reduce, list, get, my trades), idempotent `clientOrderId`; admin markets API and engine/settlement status
- [x] Tests: 14 engine scenario tests and property tests (no crossed book, conservation, no self-trade, maker price, deterministic replay, snapshot equivalence); end-to-end tests that spawn the real engine binary (settlement exactness, fees, partial fills, stops, halts, 40 concurrent orders with conservation and reconciliation, restart recovery, tamper refusal)

## Phase 4 acceptance criteria (Sprint 4)

- [x] ADR for market data sourcing, freshness, the WebSocket protocol and its security ([ADR-0009](../decisions/0009-market-data.md))
- [x] Order book, trades, OHLCV candles (1m–1d) and 24h ticker derived only from settled state; snapshots tagged with the settlement sequence; fill time from the engine event
- [x] Freshness states (`live` / `delayed` / `halted`), pushed even when the sequence is stuck
- [x] WebSocket gateway: public and private channels, origin check, session re-validation, connection/subscription/message limits, heartbeat; REST mirrors
- [x] Trading terminal: market selector, candlestick chart, order book with depth, recent trades, order form (limit/market/stop, protection price, exact totals), open orders/history/my trades, stale and halt warnings; markets page with real statistics
- [x] Playwright browser end-to-end tests against the Compose stack, in CI
- [x] First load measurement with bottleneck analysis ([performance](../operations/performance.md))

## Sprint 5 plan: Phase 5, spot paper trading and simulation

1. **ADR:** paper trading as a separate ledger namespace, so simulated balances
   can never mix with real ones (distinct account types and assets, or a
   separate schema), and how simulation markets mirror real market rules.
2. **Replay/simulation harness:** deterministic replay of recorded command logs
   through the engine. This allows "what-if" testing of rule changes and
   regression testing of the engine with production-like flows.
3. **Settlement throughput:** settle multiple fills per ledger transaction, or
   pipeline settlement per market, guided by the measurements in
   `docs/operations/performance.md`. Target: settlement keeps pace with order entry.
4. **Order entry abuse controls:** per-user order rate limits and open-order caps.
5. **Faucet UX for paper trading:** rate-limited, clearly labelled simulated funds.
6. **Tests:** isolation property (no posting can touch both namespaces) and
   replay determinism across engine versions.
