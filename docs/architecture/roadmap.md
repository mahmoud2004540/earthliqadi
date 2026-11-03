# Delivery roadmap

Phases are sequential. A phase is complete only when its acceptance criteria,
tests, security review and documentation are done.

| Phase | Scope                                                      | Status       |
| ----- | ---------------------------------------------------------- | ------------ |
| 0     | Architecture and repository foundation                     | **Complete** |
| 1     | Frontend, backend, authentication, database, Docker, CI    | **Complete** |
| 2     | Financial ledger and accounting                            | **Complete** |
| 3     | Spot matching engine (Rust)                                | Next         |
| 4     | Market data and professional trading terminal              | Planned      |
| 5     | Spot paper trading and simulation                          | Planned      |
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
- [x] Responsive bilingual (EN/AR, LTR/RTL) web app with public, auth and dashboard pages
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
- [x] User balances and history API and dashboard (EN/AR); staff read API with audited access
- [x] Simulated deposits for development only, refused outside `local`/`ci`
- [x] Tests: property-based, concurrency, idempotency races, DB invariants, reconciliation tamper detection

## Sprint 3 plan: Phase 3, spot matching engine

**Goal:** a deterministic, independently testable matching engine. It never
touches balances; the ledger settles its output.

1. **ADR:** engine boundaries; the command/event protocol (an append-only input
   log with sequence numbers); recovery by snapshot plus replay; how the
   API ↔ engine transport starts (in-process queue vs TCP vs Redpanda; the
   simplest option that is durable and measured).
2. **Market registry:** symbol, base/quote asset, tick size, lot size, min/max
   notional, and status (configured via `markets:configure`, audited).
3. **Rust crate `services/matching-engine`:** order book per market,
   price-time priority, limit, market and stop (trigger) orders,
   partial fills, cancel, amend (price change = cancel/replace; size reduce in
   place), self-trade prevention, and fixed-point integer prices and quantities.
4. **Order state machine:** `NEW → OPEN → PARTIALLY_FILLED → FILLED | CANCELLED | REJECTED | EXPIRED`,
   with every transition an event.
5. **Settlement:** the API holds funds before an order is accepted; each fill
   becomes one balanced multi-asset journal entry (base and quote legs plus fee),
   with idempotency key `fill:<market>:<sequence>`; releases on cancel.
6. **Tests:** deterministic replay (same input log ⇒ byte-identical events),
   property tests (no crossed book, conservation of quantity, price-time order),
   fuzzing of the command parser, and a ledger settlement integration test.
7. **Out of scope:** market data fan-out and trading UI (Phase 4), perpetuals (Phase 6).
