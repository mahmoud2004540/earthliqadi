# ADR-0007: Spot matching engine and settlement

- Status: Accepted
- Date: 2026-11-03
- Phase: 3

## Context

Orders must be matched deterministically, with price-time priority, and must
survive crashes without losing or duplicating fills. The engine must never
touch balances: funds are held before an order reaches the engine, and every
fill is settled by the ledger (ADR-0006).

## Decision

### Components

```
 API (NestJS)                     PostgreSQL                          engine-server (Rust)
 ───────────                      ──────────                          ────────────────────
 POST /v1/orders ── tx: hold funds ─► orders, journal_entries
                       + command   ─► engine_commands (market, seq) ──► read in seq order
                                                                       apply to in-memory book
 settlement worker ◄── engine_events (market, seq) ◄──── tx: events + engine_market_state
   tx: TRADE entries, releases,
   order status, trades, offset
```

- **Engine (`services/matching-engine`, Rust):** a pure library (`OrderBook`,
  `Sequencer`) with no I/O, no clocks and no randomness, plus an
  `engine-server` binary that moves commands and events between the library and
  PostgreSQL.
- **Durable command log:** the API writes each command to `engine_commands` in the
  same database transaction that holds the user's funds. An order therefore
  exists for the engine if and only if its funds are held.
- **Gap-free per-market sequence:** the API takes the next sequence number by
  incrementing `markets.next_command_seq`. That row lock is held until commit, so
  sequence numbers commit in order and a rolled-back transaction leaves no gap.
  The engine checks that every command it reads is exactly `last + 1` and
  refuses to continue otherwise.
- **Exactly-once event output:** the engine writes a batch's events and its new
  offsets (`engine_market_state`: last command, last event, state hash) in one
  transaction, guarded by an optimistic check on the previous offset.
- **Single active engine:** a PostgreSQL advisory lock is held on the engine's
  session. A second instance waits as a hot standby.
- **Settlement worker (API):** reads `engine_events` per market after
  `settlement_state.last_event_seq`. It locks that row with
  `FOR UPDATE SKIP LOCKED`, so only one API instance settles a market at a time.
  Each batch is one transaction: ledger entries (idempotency keys
  `trade:<market>:<seq>`, `order-release:<order>:<seq>`), order status, trades and
  the offset commit together. If an event cannot be settled, the transaction
  rolls back and settlement for that market **stops** (with an error log) rather
  than skipping money movements.
- **Transport:** PostgreSQL with `LISTEN/NOTIFY` wake-ups and polling as a fallback.
  This trades latency (milliseconds, not microseconds) for durability and
  simplicity. A dedicated log (e.g. Redpanda) will replace it only when measured
  load requires it; the command/event schema is designed to carry over.

### Units

- `price` is an integer number of **ticks**. A tick is `markets.tick_size`
  minor units of the quote asset per one whole base unit.
- `quantity` is an integer number of **lots**. A lot is `markets.lot_size`
  minor units of the base asset.
- Market creation requires `tick_size × lot_size` to be divisible by
  `10^base_scale`. Every fill's quote amount is then an exact integer:
  `quote = price × quantity × (tick_size × lot_size / 10^base_scale)`.
- Prices and quantities are capped at 10^12 ticks or lots, which keeps them well
  inside `i64` and ledger limits.

### Matching rules

- **Price-time priority.** Trades execute at the **maker's** price.
- **Order types:** `limit`, `market`, `stop_limit`, `stop_market`.
  Time in force: `gtc`, `ioc`, `fok`, `post_only`.
  - Market and stop-market orders are IOC/FOK only. **Market buys must carry a
    protection price** (the maximum the user accepts), because funds are held up
    front and no reference price exists yet.
  - `post_only` is rejected if it would take liquidity.
  - `fok` is cancelled in full if it cannot fill completely.
- **Stops** trigger on the last trade price of that market (buy: `last ≥ stop`;
  sell: `last ≤ stop`). They trigger in arrival order, and cascades are handled
  deterministically. A stop that would trigger immediately is rejected.
  Perpetual futures will use mark price instead (Phase 6, ADR-0006 rule: never
  last price alone for liquidations).
- **Self-trade prevention:** when a taker meets its own resting order, the
  taker's remainder is cancelled (`self_trade_prevention`) and the resting order
  stays.
- **Amend:** a quantity reduction keeps time priority. A price change is
  cancel-and-replace on the client side.

### Order state machine (API projection)

```
PENDING_NEW ─accepted─► OPEN ─trade─► PARTIALLY_FILLED ─filled─► FILLED
     │                   │  └──────────────filled────────────────┘
     │ (stop) accepted ► PENDING_TRIGGER ─stop_triggered─► OPEN
     └─rejected─► REJECTED        any open state ─cancelled─► CANCELLED
```

Any other transition is a bug and stops settlement for that market.

### Fees

Maker and taker fees are basis points per market. They are taken from the asset
the user **receives** and credited to `FEE_REVENUE`. They are rounded **down** in
the customer's favour, so a tiny fill may carry no fee. No fee is reserved at
order time.

### Determinism and recovery

- The engine state hash is a SHA-256 chain over **every command and every event**
  (`h = sha256(h_prev ‖ tag ‖ bytes)`). Different inputs always produce
  different hashes, even when they happen to emit identical events (a property
  test caught exactly this when only events were hashed).
- On startup, the engine **replays** every already-processed command and checks
  that the replay reproduces the stored event sequence number and state hash. On
  a mismatch it refuses to start.
- Snapshots are implemented in the library (serialise and restore, tested
  equivalent to continuous operation). Startup still replays from the beginning;
  loading snapshots is an optimisation for when the log grows.

## Consequences

- No fill can be posted twice: there are idempotency keys and transactional
  offsets on both sides of the log.
- No order can execute without held funds: hold and command are written in one
  transaction.
- Throughput is limited by PostgreSQL round trips and per-market serialisation.
  We accept this until there is load data; measurement is a Phase 4/5
  deliverable.
- Per-order lookups use ordered maps for deterministic serialisation. Some
  operations are O(n) in the number of orders at a price level or in pending
  stops. This is acceptable at current scale and documented for optimisation.
