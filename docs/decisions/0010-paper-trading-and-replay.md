# ADR-0010: Paper trading namespace, faucet, order limits and engine replay

- Status: Accepted
- Date: 2026-11-03
- Phase: 5

## Context

Phase 5 adds paper trading (trading with simulated funds on real exchange
mechanics) and simulation tooling. The overriding risk is **contamination**:
simulated value must never be able to reach, offset or masquerade as real
balances, in any environment, even through a bug.

## Decision

### One ledger, two namespaces, enforced by the database

Paper trading reuses the real engine, settlement, ledger and market data, so it
exercises exactly the production code paths. Isolation is part of the data
model:

| Rule                                                                                                       | Enforcement                                                                 |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Every asset is either paper or real (`assets.is_paper`); the flag, code and scale are immutable            | `assets_guard_update` trigger                                               |
| A market's assets and the market itself are all paper or all real                                          | `markets_check_namespace` trigger (+ service check); flag immutable         |
| **No journal entry may contain postings on both paper and real assets**                                    | `postings_single_namespace` deferred constraint trigger (checked at commit) |
| Faucet accounts (`PAPER_FAUCET`) only for paper assets; development simulated custody only for real assets | `ledger_accounts_check_namespace` trigger                                   |
| Reconciliation re-checks the namespace rule (defence against bypassed triggers)                            | `MIXED_NAMESPACE_ENTRY` finding                                             |

Because a trade's postings are all on the market's two assets, and a market
cannot mix namespaces, paper fills, fees and releases stay paper by
construction. The triggers make that guarantee independent of application code.

### Faucet

- `POST /v1/paper/faucet {asset}` grants the paper asset's configured
  `faucet_amount` (set at asset creation and required for paper assets).
- At most **once per user, asset and UTC day**. The journal idempotency key
  `paper-faucet:<user>:<asset>:<YYYY-MM-DD>` enforces this, so concurrent
  requests cannot double-grant. Repeats return `429 RATE_LIMITED`.
- Available in every environment (paper funds have no value and cannot cross
  namespaces). Grants are audited, and descriptions state "simulated, no value".
  The UI labels paper markets and assets.

### Order abuse controls

- Per-user order command rate (place, cancel and reduce): `ORDER_RATE_LIMIT_PER_SECOND`
  (default 10), a fixed one-second window in Redis shared across API instances.
- Open orders per user per market: `MAX_OPEN_ORDERS_PER_MARKET` (default 200).
  The count check is not transactional, so a burst may briefly exceed the cap by
  the number of in-flight requests. This is acceptable for abuse protection; it
  is not a financial invariant.

### Engine replay verification (`engine-replay`)

A read-only binary shipped in the engine image. In one `REPEATABLE READ READ ONLY`
snapshot it replays each market's command log through the **current** engine
build and compares every produced event (sequence, command sequence, full
payload) and the final state hash with the recorded log. It exits 0 if
identical and 2 on the first divergence, reporting the event position and both
payloads.

**Policy:** an engine release may be deployed only after `engine-replay`
passes against a recent production snapshot. This protects deterministic
replay across engine versions. Intentional behaviour changes need a migration
plan (a new ADR) because history would no longer replay identically.

### Settlement batching (performance, related to ADR-0007)

Settlement now applies a batch of events in memory and writes it with a
constant number of round trips. `LedgerService.postBatchWithin` provides the
same guarantees as single postings: validation, per-asset balance, idempotency
with fingerprints, sequential overdraft pre-check, and id-ordered locks. An
integration test asserts that batched and event-by-event settlement produce
identical orders, trades and balances.

## Consequences

- Paper trading is safe to offer publicly without risking real balances, and it
  continuously exercises production code paths.
- Real and paper assets share tables. Reports and Proof of Reserves must always
  filter by `is_paper = false` (to be enforced when those reports are built,
  Phase 9).
- Engine changes now carry a verifiable compatibility gate.
