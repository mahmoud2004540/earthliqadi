# ADR-0006: Double-entry ledger design

- Status: Accepted
- Date: 2026-11-03
- Phase: 2

## Context

Every financial operation (deposits, holds for orders, trades, fees, withdrawals,
corrections) must be traceable, balanced and impossible to apply twice. Balances
must never go negative where that is not allowed, including under concurrent
requests. The ledger must be independent of the matching engine: the engine
proposes fills, and the ledger decides whether they post.

## Decision

### Amount representation

- Every amount is an **integer number of minor units** of its asset (satoshi,
  wei, micro-USDT…). Each asset has a fixed `scale` (0–18): `1 BTC` with scale 8
  is `100000000`.
- PostgreSQL stores amounts as `NUMERIC(38,0)`. TypeScript uses `bigint` only.
  **`number` and binary floating point are never used for amounts.**
- At API boundaries, amounts are decimal strings (`"0.015"`). Parsing rejects
  more fractional digits than the asset scale; nothing is ever rounded silently.

### Accounts

`ledger_accounts` has one row per (asset, type, owner). `owner_key` is the user
id or `system`.

| Type                | Normal side | Owner  | May be negative | Meaning                                                 |
| ------------------- | ----------- | ------ | --------------- | ------------------------------------------------------- |
| `USER_AVAILABLE`    | credit      | user   | no              | Liability: spendable customer funds                     |
| `USER_LOCKED`       | credit      | user   | no              | Liability: funds held for open orders or withdrawals    |
| `FEE_REVENUE`       | credit      | system | no              | Exchange fee income (Phase 3+)                          |
| `SUSPENSE`          | credit      | system | yes             | Unresolved items awaiting investigation                 |
| `SIMULATED_CUSTODY` | debit       | system | no              | **Development only**: counterpart of simulated deposits |

`EXTERNAL_CUSTODY` and `INSURANCE_FUND` are added in Phases 8 and 6 with their
features. Accounts are created lazily and never deleted.

### Journal

- A `journal_entry` has a type, a unique **idempotency key**, a request
  **fingerprint** (SHA-256 of type + postings + reversal target), the actor, and
  optionally the entry it reverses.
- `postings` hold (entry, account, asset, direction, amount > 0).
- **Invariants enforced by the database** (so they hold even if application
  code is wrong):
  1. Every entry has ≥ 2 postings and **debits = credits per asset**. This is a
     `DEFERRABLE INITIALLY DEFERRED` constraint trigger, checked at commit.
  2. `journal_entries` and `postings` are **immutable**: UPDATE, DELETE and
     TRUNCATE raise an error.
  3. `ledger_accounts.balance` changes **only** via the posting trigger. A
     guard trigger rejects direct balance updates and changes to an account's
     identity (asset, type, owner, normal side). Accounts cannot be deleted.
  4. `CHECK (allow_negative OR balance >= 0)`.
  5. An entry can be reversed at most once (`UNIQUE(reverses_entry_id)`).

### Posting algorithm

The application service runs everything in one transaction (READ COMMITTED):

1. Validate the request (≥ 2 postings, positive amounts, distinct accounts,
   balanced per asset).
2. `SELECT … FOR UPDATE` every affected account, **ordered by id**. Every
   transaction locks in the same order, so there are no deadlocks.
3. Compute the resulting balances. If a non-negative account would go below
   zero, fail with `INSUFFICIENT_FUNDS`; nothing is written.
4. Insert the entry and its postings. The trigger applies the balance changes;
   the CHECK constraint and the deferred balance check are the backstop.

Idempotency: if the key already exists with the same fingerprint, the original
entry is returned (`replayed: true`). With a different fingerprint, the request
fails with `IDEMPOTENCY_CONFLICT`. A concurrent duplicate loses the
unique-index race, its transaction rolls back, and it then resolves to a replay.

### Corrections

Posted entries are never edited. A correction is a **reversal** entry (mirror
image of the original, linked by `reverses_entry_id`) or, later, an adjusting
entry. Staff-initiated adjustments need maker-checker approval and arrive with
the admin app (Phase 7); there is no manual adjustment endpoint in Phase 2.

### Reconciliation

A reconciliation run takes a consistent `REPEATABLE READ` snapshot and checks:

- each account's projected balance = the balance recomputed from its postings
- every entry is balanced per asset and has ≥ 2 postings
- the global trial balance per asset is zero
- no non-negative account is negative

Results are stored append-only in `ledger_reconciliation_runs`. A mismatch is
logged at error level and audited. From Phase 8, withdrawals must be blocked
while the latest run is not `OK`. Runs are scheduled (interval configurable,
with a Redis lock so only one instance runs) and can be triggered by staff
(`ledger:reconcile`) or the CLI.

## Consequences

- Correctness does not depend on every future caller being careful; the
  database rejects unbalanced, mutating or overdrawing writes.
- Per-account row locks serialise writes to hot accounts. This is acceptable for
  now. When the matching engine arrives, a hot account (e.g. fee revenue) may be
  sharded into sub-accounts or settled in batches; that needs a new ADR.
- No assets are seeded: listing an asset is a business decision. Development
  uses the CLI to create test assets and **simulated** deposits, which are
  refused outside `DEPLOY_ENV=local|ci`.
