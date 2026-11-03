# Performance baseline (Sprints 4–5)

Measured with `tests/load/order-flow.mjs` against the local Docker Compose stack
(edge → API → PostgreSQL → engine → settlement), inside a 4-vCPU development
container that also runs the database, Redis, the engine and the load
generator. **These numbers describe this development setup only. They are not
production capacity claims.**

Scenario: a fresh market; orders alternate between resting sells and crossing
buys at one price (1 lot each), so every buy produces a trade. 2,000 orders,
32 concurrent clients.

Latencies are taken from database timestamps: command enqueued → first engine
event (`commandToEngineEventMs`), and engine fill → settled trade row
(`fillToSettlementMs`).

## Iterations

| #   | Change                                                     | Traders | Orders/s (end-to-end) | HTTP order entry p50 / p95 | Engine p50 | Fill → settled p50           |
| --- | ---------------------------------------------------------- | ------- | --------------------- | -------------------------- | ---------- | ---------------------------- |
| 1   | Baseline                                                   | 2       | 20                    | 1,557 / 2,451 ms           | 6 ms       | 861 ms                       |
| 2   | Market sequence lock taken last; settlement batch 200 → 50 | 2       | 24                    | 1,463 / 1,833 ms           | 12 ms      | 1,730 ms                     |
| 3   | Same code; load spread over 32 traders (realistic)         | 32      | 24 (submit ≈ 39)      | 785 / 1,347 ms             | 14 ms      | 28,967 ms (backlog)          |
| 4   | Cached ledger account ids (first attempt)                  | 32      | —                     | —                          | —          | — **deadlocked** (see below) |
| 5   | Transaction-scoped account resolution (fix)                | 32      | **28** (submit ≈ 44)  | **678 / 1,185 ms**         | 20 ms      | 25,247 ms (backlog)          |
| 6   | Sprint 5: batched in-memory settlement                     | 32      | **49**                | **585 / 936 ms**           | 22 ms      | **1,508 ms** (no backlog)    |

All completed runs (1–3, 5, 6): **0 failed orders, reconciliation OK**. Correctness held
under load in every completed run.

## Findings

1. **The engine is not the bottleneck.** Command → event takes about 6–16 ms
   p50, including the PostgreSQL round trips.
2. **Per-user serialisation is by design.** Orders of one user lock that user's
   balance rows (no double spending). With 2 traders, 32 clients queued on 2 rows
   (iterations 1–2), so realistic load tests must spread orders over many users
   (iteration 3+).
3. **The market sequence lock** is now taken as the last statement of the
   order-entry transaction. It is still held until commit (sequences stay
   gap-free and commit-ordered, ADR-0007) but no longer serialises the order
   insert and fund hold.
4. **Settlement throughput is the limit** (iteration 3). Order entry outran
   settlement, so fills waited ~29 s to settle and the market was correctly
   flagged `delayed`. Each fill made about 12 extra queries just to resolve
   ledger accounts.
5. **Pool-starvation deadlock (iteration 4, found by this load test).** The
   first account cache resolved missing accounts on a _second_ pool connection
   from inside the settlement transaction. Under load, order-entry transactions
   held all 9 pool connections while waiting on row locks held by the
   settlement transaction, and settlement waited for a free connection. Requests
   failed after the 10 s pool timeout.
   - **Rule:** never acquire a second connection while holding a transaction.
   - **Fix:** `LedgerService.transactionalAccounts(tx)` resolves accounts with
     the transaction's own connection and caches ids only after commit.
   - **Regression test:** `ledger.e2e-spec.ts` uses a one-connection pool, so it
     is deterministic. It was verified to fail with the bug reintroduced.

6. **Settlement profiling (Sprint 5).** A 1,000-event backlog settled at
   99 events/s. Each fill needed about 10 round trips of ~2.4 ms inside the
   transaction. Applying a batch of events in memory and writing it with bulk
   statements (`LedgerService.postBatchWithin`, `trades.createMany`, one
   `UPDATE … FROM unnest(…)` for orders) raised this to **497 events/s (5×)**.
   An integration test proves batched and event-by-event settlement produce
   identical results.

**Current state (iteration 6):** settlement keeps pace with order entry (fill →
settled p50 1.5 s, p95 3.0 s; the backlog drained 0.5 s after the last
submit). The limit is now order entry (~50 orders/s end to end on this shared
4-vCPU container): one transaction per order with several round trips plus the
per-market sequence lock.

## Next steps

- Order entry: fewer round trips per order (for example a single stored
  procedure for hold + insert + sequence, or batched intake per market).
- Settlement: set-based trigger checks instead of per-row deferred checks.
- Measure again with a dedicated database host. This container shares 4 vCPUs
  across every component.
- Per-user order limits exist (Sprint 5); the load test raises them.

## How to run

```bash
RATE_LIMIT_DEFAULT_PER_MINUTE=10000000 RATE_LIMIT_AUTH_PER_MINUTE=10000 \
  ORDER_RATE_LIMIT_PER_SECOND=100000 MAX_OPEN_ORDERS_PER_MARKET=1000000 \
  docker compose up -d --no-build api
ORDERS=2000 CONCURRENCY=32 TRADERS=32 node tests/load/order-flow.mjs
docker compose up -d --no-build api   # restore normal rate limits afterwards
```
