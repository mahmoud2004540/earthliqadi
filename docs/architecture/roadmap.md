# Delivery roadmap

Phases are sequential. A phase is complete only when its acceptance criteria,
tests, security review and documentation are done.

| Phase | Scope                                                      | Status       |
| ----- | ---------------------------------------------------------- | ------------ |
| 0     | Architecture and repository foundation                     | **Complete** |
| 1     | Frontend, backend, authentication, database, Docker, CI    | **Complete** |
| 2     | Financial ledger and accounting                            | Next         |
| 3     | Spot matching engine (Rust)                                | Planned      |
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

## Sprint 2 plan: Phase 2, the financial ledger

**Goal:** a double-entry ledger that can be shown to be correct before any trading
code exists.

1. **Design (ADR):** chart of accounts (user available/locked, fees, suspense,
   external custody, insurance fund), asset registry with per-asset precision, and
   a fixed-precision decimal representation. The candidate is integer minor units
   in `NUMERIC(38,0)` with a per-asset scale. `number` is never used for amounts.
2. **Schema:** `assets`, `ledger_accounts`, `journal_entries`, `postings`, and
   `balances` as a projection. Constraints: postings in each journal entry sum to
   zero per asset (deferred constraint trigger). Journal tables are
   immutable (same trigger pattern as audit). Idempotency key is unique per
   operation type.
3. **Ledger service:** `post(entry)` in a single serializable transaction or with
   row-level locking (`SELECT … FOR UPDATE`) on affected balance rows, in a
   deterministic lock order to avoid deadlocks. It must never allow negative
   available balances, and it supports hold/release (available→locked) for
   future orders.
4. **Corrections:** only via compensating entries that reference the original.
5. **Reconciliation:** a job that recomputes balances from postings and compares
   them with the projection. Mismatches raise alerts and block withdrawals.
6. **Tests:** property-based tests (random operation sequences keep invariants),
   concurrency tests (parallel postings on one account must never overdraw), an
   idempotency test (replayed keys post once), and reconciliation tests.
7. **Admin read API:** ledger inquiry gated by `reports:read`, with every access
   audited.
8. **Out of scope:** deposits/withdrawals (Phase 8), matching (Phase 3), and any
   UI beyond read-only balances.
