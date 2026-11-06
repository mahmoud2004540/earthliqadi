# Runbooks

Each alert in `infrastructure/monitoring/prometheus/alerts.yml` links here.

General rules:

- **Never "fix" balances by hand.** Corrections are reversals approved
  through maker-checker (`ledger.reversal`).
- Halting a market is a single-person emergency control
  (`PATCH /v1/admin/markets/:symbol/status`). Resuming it needs a second
  person (`market.resume`).
- Record what you did in the incident log; the audit log records the system
  side.

## Ledger reconciliation mismatch

1. Halt trading on the affected assets' markets.
2. Read the latest run's findings (`GET /v1/admin/ledger/reconciliations`, or
   `ledger reconcile` in the CLI). Each finding names the account, entry,
   market or asset.
3. `BALANCE_MISMATCH`, `UNBALANCED_ENTRY` or `MIXED_NAMESPACE_ENTRY` mean
   database integrity was bypassed: treat it as a security incident
   (`docs/security/incident-response.md`).
4. Perpetual findings (`POSITION_MARGIN_MISMATCH`, `PERP_CLEARING_MISMATCH`,
   `OPEN_INTEREST_IMBALANCE`, `FUNDING_POOL_MISMATCH`) point to a
   settlement or risk-engine defect. Keep the market halted and preserve
   evidence; do not resume until the root cause is fixed and reconciliation
   is OK.

## Ledger reconciliation stale

The scheduler has not run. Check API health and logs for
`Scheduled ledger reconciliation failed`, and Redis (the scheduler lock).
Run `ledger reconcile` manually.

## Settlement halted

Logs show `SETTLEMENT_HALTED` with the error. Settlement never skips an
event.

1. Find the market and event (`GET /v1/admin/engine/status`, logs).
2. A `SettlementInvariantError` is a defect or tampering: halt the market and
   investigate. Never edit engine events.
3. Insufficient insurance fund on a bankrupt perpetual fill: seed the fund
   through maker-checker (`insurance_fund.seed`, moves collected fees), then settlement
   resumes by itself.

## Settlement lag high

Settlement cannot keep up. Check database latency and CPU. The market is
flagged `delayed` to users automatically. See `performance.md`.

## Engine backlog high

The engine is not consuming commands. Check the `engine` service
(`docker compose logs engine`), the active/standby advisory lock, and
`engine-replay` if it refused to start (state hash mismatch: do not bypass).

## Perpetual index stale

No reliable index price: funding, liquidations and risk-increasing orders
are paused by design. Check the index sources (spot book depth, simulated
feed state in `perp_market_state`). Do not lower `minSources` to make it
go away.

## Perpetual risk engine failing

Logs show `PERP_RISK_TICK_FAILED`. Liquidations and funding are not running.
Fix the cause quickly. If prices move in the meantime, halt the affected
perpetual markets.

## Liquidations stuck

A position stays `LIQUIDATING` while its IOC orders find no liquidity at or
better than the bankruptcy price. Check book depth. Insurance-fund takeover
and ADL are not live (ADR-0011): escalate to the risk officer.

## API error rate high

Check logs for the failing route (`route` label). Common causes: database
or Redis unavailable (readiness probe), or a bad deployment (roll back).

## Market halted

A reminder that a market has been halted for 30 minutes. Either resume it
(maker-checker `market.resume`) or post an announcement.

## Compliance queue backlog

Identity verifications are waiting. Staff the review queue. Never approve
in bulk.

## Vault indexer halted (ChainInvariantError)

The indexer found an on-chain withdrawal the ledger never signed, or one that
does not match. Treat it as a **possible operator-key compromise**: rotate the
signer, halt vault-backed markets, compare `chain custody` with the vault, and
escalate. Never edit chain records by hand.

## Vault custody mismatch

`chain custody` shows ledger ≠ on-chain at the indexed block. Check for a
reorg or an RPC returning stale data, re-run the indexer, and halt vault-backed
markets if the difference persists.

## Backups

Run `scripts/backup.sh` on schedule and `scripts/restore-drill.sh <dump>` at
least weekly. A backup that has not passed a drill does not count. Keep dumps
encrypted and off-host (they contain personal data).

## Signer refusing withdrawals

`409 LIMIT_EXCEEDED` with a signer policy code (`DAILY_LIMIT`,
`PER_TX_LIMIT`, ...) is the signer protecting the vault. Check its audit log.
Raise limits only with maker-checker sign-off, and investigate unusual volume
first: a spike can mean an API compromise.

## Step-up / IP allow-list lockouts

`STEP_UP_REQUIRED` means re-confirming with the authenticator.
`IP_NOT_ALLOWED` means the staff member is outside `ADMIN_IP_ALLOWLIST`;
change the list only through the infrastructure change process, never ad hoc.
