# Delivery roadmap

Phases are sequential. A phase is complete only when its acceptance criteria,
tests, security review and documentation are done.

| Phase | Scope                                                          | Status       |
| ----- | -------------------------------------------------------------- | ------------ |
| 0     | Architecture and repository foundation                         | **Complete** |
| 1     | Frontend, backend, authentication, database, Docker, CI        | **Complete** |
| 2     | Financial ledger and accounting                                | **Complete** |
| 3     | Spot matching engine (Rust)                                    | **Complete** |
| 4     | Market data and professional trading terminal                  | **Complete** |
| 5     | Spot paper trading and simulation                              | **Complete** |
| 6     | Perpetual futures and risk simulation (paper only)             | **Complete** |
| 7     | Admin, compliance and monitoring                               | **Complete** |
| 8     | Non-custodial vault, deposits/withdrawals (testnet), liquidity | Next         |
| 9     | Security audits and regulatory readiness                       | Planned      |
| 10    | Controlled production launch, after all required approvals     | Planned      |

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

## Phase 5 acceptance criteria (Sprint 5)

- [x] ADR for the paper namespace, faucet, order limits and replay ([ADR-0010](../decisions/0010-paper-trading-and-replay.md))
- [x] Paper assets and markets; database-enforced isolation (no market or journal entry can mix paper and real; immutable flags; namespace-restricted account types); reconciliation check
- [x] Paper faucet: once per user, asset and UTC day (idempotency-key enforced), audited, labelled in the UI
- [x] Settlement throughput: profiling (~2.4 ms per round trip, ~10 round trips per fill), then in-memory batching with bulk writes; **~5× events/s**; batched ≡ event-by-event equivalence test
- [x] Order abuse controls: per-user order command rate limit, open-order cap per market
- [x] `engine-replay`: verifies the current engine build reproduces recorded history exactly; shipped in the engine image
- [x] Tests: namespace isolation (incl. trigger-bypass detection), faucet, limits, replay (Rust + against real history), paper e2e in the browser

## Phase 6 acceptance criteria (Sprint 6)

- [x] ADR for the contract, position accounting, margin, index/mark, funding, liquidation and ADL ([ADR-0011](../decisions/0011-perpetual-futures.md))
- [x] Paper-only perpetuals, database-enforced (market CHECK; derivative account types refused for real assets)
- [x] Positions with exact integer accounting; clearing identity (Σ entry = clearing balance) property-tested and reconciled; margin, open-interest and funding-pool reconciliation
- [x] Order entry: margin holds, leverage, validated risk tiers, reduce-only, bankruptcy-price and price-band checks
- [x] Index (median, staleness, outlier rejection; spot or labelled simulated sources) and mark (index + clamped basis EMA; never last trade)
- [x] Funding: clamped premium rate, zero-sum allocation capped at margin, idempotent rounds
- [x] Liquidation: flag, cancel, IOC protected at the bankruptcy price, fee to the insurance fund; paper insurance-fund seeding
- [x] Risk simulation harness (synthetic paths; insurance fund then ADL); ADL not live
- [x] Terminal: mark/index/funding, leverage, reduce-only, positions with estimated liquidation price, add margin
- [x] Tests: property tests (PnL identity, bankruptcy bound, funding, simulation conservation); integration with the real engine (open/close, limits, funding, liquidation, reconciliation); browser e2e

## Phase 7 acceptance criteria (Sprint 7)

- [x] ADR for staff MFA, maker-checker, KYC, support and monitoring ([ADR-0012](../decisions/0012-admin-compliance-monitoring.md))
- [x] Staff permissions require account MFA (`MFA_REQUIRED`); cannot be disabled outside local/ci
- [x] Maker-checker requests (market resume, insurance seed, ledger reversal, reactivation, role grants): database-enforced four eyes, immutable decisions, idempotent execution, expiry, cancellation, audit, notifications
- [x] Immediate single-person protective controls: market halt, user suspension (sessions revoked)
- [x] KYC: encrypted profile (separate key), restricted-country and sanctions-provider boundary (no provider claimed), officer review with audited decryption, KYC gate for real trading
- [x] Support tickets (append-only messages), in-app notifications, announcements
- [x] Admin console (overview, approvals, KYC, support, users, audit) and user verification/support/inbox tabs
- [x] Prometheus metrics endpoint (token, edge-blocked), alert rules and runbooks
- [x] Tests: guard unit tests; 12 integration tests (MFA, four eyes, DB backstops, KYC encryption/screening/gate, support, metrics); browser e2e (KYC + support reviewed in the admin console, customer denied)

## Interim change (ADR-0013): wallet sign-in, no KYC

- [x] Sign-In with Ethereum (EIP-4361): single-use nonces, domain/URI binding, signature recovery (audited `@noble`), EIP-55, automatic account creation
- [x] KYC module off by default (404); no verification tab; staff keep email + password + MFA
- [x] Tests: SIWE unit tests (incl. a published key vector), integration (replay, foreign domain, forged signature, DB identity rules), browser e2e with an injected EIP-1193 test wallet

## Phase 8 acceptance criteria (Sprint 8)

- [x] ADR for the vault, withdrawals, state commitments and the escape hatch ([ADR-0014](../decisions/0014-non-custodial-vault.md))
- [x] `ExchangeVault` + `TestToken` (Solidity 0.8.28): deposits, EIP-712 operator-signed withdrawals, sequential state roots, freeze + Merkle escape + late-deposit escape, reentrancy guard, high-s rejection, no admin keys
- [x] Foundry suite: unit, fuzz (1000 runs), invariant (vault = Σ in − Σ out); CI job from the pinned official image
- [x] Indexer (confirmations, idempotent per event, invariant halts), withdrawal holds and chain-time expiry, state committer with stored leaves and user proofs, custody reconciliation vs. on-chain
- [x] Local chain (Anvil) in Compose; deploy CLI; local faucet; mainnets refused; raw operator key refused outside local/ci
- [x] UI: vault panel (test tokens, deposit, withdraw from the wallet, proof download)
- [x] Tests: Merkle property tests; live-chain integration test of the full cycle, including freeze and escape with exact payouts; browser e2e with an injected wallet

## Phase 9 acceptance criteria (Sprint 9, engineering part)

- [x] ADR ([ADR-0015](../decisions/0015-security-and-operational-readiness.md)) and an honest [production-readiness checklist](../operations/production-readiness.md)
- [x] Isolated signer service: HMAC + replay protection, chain/vault/token allow-lists, per-withdrawal and daily limits, chain-time expiry window, single-use ids, append-only audit log that restores limits after restarts; API in remote-signer mode; raw keys refused outside local/ci
- [x] Step-up re-authentication for sensitive staff actions; admin IP allow-list
- [x] Backup script and restore drill (checksum, restore, row counts, full reconciliation on the restored copy)
- [x] Monitoring profile: Prometheus (bearer token), Alertmanager, Grafana dashboard; rules validated with promtool; scrape verified
- [x] Personal data export (no secrets; audited)
- [ ] External: smart-contract audit, penetration test, legal analysis, HSM/KMS, on-call (not claimed)

## Sprint 10 plan: Phase 10, controlled launch preparation (only after the external items)

1. **Infrastructure as code** for a staging environment (managed Postgres with
   PITR, Redis, private networks, secret manager, the signer on its own host
   with an HSM/KMS backend, WAF at the edge).
2. **Public testnet** deployment (e.g. Sepolia) with higher confirmation
   counts, reorg handling, and an external RPC with failover.
3. **Release process:** signed images, SBOM, staged rollout, `engine-replay`
   gate, database migration review, rollback runbooks.
4. **Launch gates:** audit findings fixed, pen-test retest, legal sign-off,
   geo-restriction live, on-call staffed, incident drill done. Real assets
   only behind explicit per-asset limits, starting very small.
