# ADR-0009: Market data and the WebSocket gateway

- Status: Accepted
- Date: 2026-11-03
- Phase: 4

## Context

The trading terminal needs an order book, recent trades, candlesticks, 24h
statistics and live updates. Market data must never be fabricated
(no synthetic depth, volume or prices), must tell users when it is stale, and
must be consistent with what was actually settled in the ledger.

## Decision

### Source of truth: settled state, versioned by the settlement sequence

All public market data is derived from **settled** state, never from a separate
feed:

| Data            | Derived from                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| Order book (L2) | `orders` with status `OPEN`/`PARTIALLY_FILLED` and resting time-in-force (`GTC`, `POST_ONLY`), aggregated by price |
| Trades          | `trades` (immutable), with the fill time `executed_at` taken from the engine event timestamp                       |
| Candles (OHLCV) | Aggregated on demand from `trades` (`date_bin`) for 1m/5m/15m/1h/4h/1d                                             |
| 24h ticker      | `trades` over a rolling 24h window, plus the best bid and ask from the book                                        |

Every snapshot carries `seq` = `settlement_state.last_event_seq` for the market,
read in the same `REPEATABLE READ` snapshot. Clients can therefore tell exactly
which engine event a book reflects, and that it is consistent with balances.

**Trade-off:** the book lags matching by the settlement delay (milliseconds in
normal operation) but can never show liquidity the ledger has not accounted for.
A direct engine book feed is a later optimisation if measured latency requires it.

### Freshness

Each book/ticker message includes a `status`:

- `halted`: the market is halted (no new orders).
- `delayed`: commands have waited more than 2 s for the engine, or events have
  waited more than 2 s for settlement.
- `live`: otherwise.

The terminal shows a visible warning when data is `delayed`, `halted` or
disconnected. Nothing is extrapolated or interpolated.

### WebSocket gateway (`/ws`; through the edge: `/api/ws`)

- JSON protocol:
  - `{"op":"subscribe","channel":"book"|"trades"|"ticker"|"candles"|"orders","market":"BTC-USDT","interval":"1m"}`
  - `unsubscribe`
  - `ping`
- The server replies with a **snapshot** on subscribe, then a new snapshot (book,
  ticker, candles) or incremental trades whenever the market's settlement `seq`
  advances. Polling interval: `MARKET_DATA_POLL_MS` (default 250 ms; works
  across multiple API instances without a message bus). Full book snapshots
  (depth ≤ 50) are simple and self-healing. Deltas are a later bandwidth
  optimisation.
- **Security:**
  - The `Origin` header must equal `WEB_ORIGIN`.
  - The private `orders` channel requires a valid session cookie at upgrade, and
    the session is re-validated every 30 s; revoked sessions are disconnected.
  - Limits: 10 connections per IP, 50 subscriptions per connection, 20 messages
    per second per connection, 4 KB maximum message size.
  - Heartbeat ping every 20 s; unresponsive clients are terminated.
- REST mirrors for snapshots:
  - `GET /v1/markets/tickers`
  - `GET /v1/markets/:symbol/book`
  - `GET /v1/markets/:symbol/trades`
  - `GET /v1/markets/:symbol/candles`

### Prices in the browser

Amounts and prices remain decimal strings end to end. The order form computes
totals with `bigint` in minor units. Only the **chart** converts strings to JS
numbers, for plotting; it is visual only and never used for money.

## Consequences

- Market data can never contradict balances; no extra infrastructure is needed.
- Book queries scan open orders per market (indexed by `market_id, status`).
  Fine at current scale; a cached projection is the next step if load requires it.
- Candles are computed per request. A materialised candle table is a later
  optimisation once trade volume justifies it.
