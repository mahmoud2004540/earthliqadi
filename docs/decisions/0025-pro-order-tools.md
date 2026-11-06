# ADR-0025: Pro order tools (trailing stop, chase, scaled, BBO, hidden, grid bots)

- Status: Accepted (owner request, 2026-11-06)
- Date: 2026-11-06
- Extends: ADR-0020 (algo orders)

## Context

The owner compared the platform with another perpetuals venue. That venue
offers order tools that the reference venue lacks, and that professional
traders and large accounts use. The owner asked for the useful ones:

- trailing stop;
- chase;
- scaled orders;
- BBO;
- hidden orders;
- grid bots with a marketplace.

Two of that venue's offers are deliberately **not** copied:

- **200x leverage.** It is harmful to users and to the insurance fund.
- **Prize draws.** They raise gambling-law risk.

## Decision

All tools are built on ordinary orders. Each child order has its own hold,
risk checks, rate limit and access policy. A tool can never spend more than
the account has. The matching engine is unchanged.

### Hidden orders

`hidden: true` on a limit order with `gtc` or `post_only`:

- **Placement.** The order rests and matches in the engine like any other
  order.
- **Visibility.** The public order book is built from the orders table, and
  that query leaves hidden orders out. The book shown over REST and the
  WebSocket shows neither their price nor their size.
- **Priority.** A hidden order keeps normal price-time priority. Displayed
  orders get no precedence.
- **Trades.** Trades still print publicly.
- **Database rule.** A CHECK restricts `hidden` to limit orders with
  `GTC` or `POST_ONLY`.

### Scaled orders

`POST /v1/orders/scale` places 2–20 limit orders.

- **Prices.** They are evenly spaced from `startPrice` to `endPrice`,
  rounded to the nearest tick.
- **Distribution.** Quantity is split `flat`, `increasing` or `decreasing`.
- **Rounding.** Leftovers go to the largest order.
- **Limits.** Each order must meet the market minimum. Too narrow a range is
  refused.

It runs as a batch: per-order results, and one request counted against the
rate limit. Order _i_ gets the clientOrderId `{prefix}-{i}`, so a retry
replays instead of duplicating.

### BBO

This is web only. A button sets the limit price to the best visible price on
the trader's own side: the best bid for a buy, the best ask for a sell.

### Trailing stop

It is an algo order with `kind: 'trailing'`.

- **Reference price.** The mark for perpetuals, the last trade for spot.
  With no fresh reference it waits and never fires blind.
- **Activation.** Tracking starts at the activation price: at or above it
  for sells, at or below it for buys. Without one, tracking starts at once.
- **Tracking.** The order follows the peak (sell) or the trough (buy).
- **Firing.** It fires when the price retraces `callbackBps` (0.1%–20%) from
  that level.
- **The order it sends.** One IOC limit order at the reference price ±
  `slippageBps` (0.1%–10%). A thin book can therefore fill it partly; the
  rest is not chased.

### Chase

It is an algo order with `kind: 'chase'`.

- **Placement.** One post-only child rests at the best visible price on its
  side.
- **Re-pricing.** When the market moves past the child, the child is
  cancelled and re-placed.
- **Cap.** It never rests beyond `price`.
- **Fees.** It always pays maker fees.
- **Limit.** It stops after 1000 re-prices.

### Grid bots

It is an algo order with `kind: 'grid'`.

**Levels.** `gridCount` (2–100) arithmetic intervals between `lowerPrice` and
`upperPrice`.

**Starting orders.** At start, against the reference price (or the mid
price):

- **long:** buys on every level below. This is the only direction for spot,
  since spot cannot sell what it does not hold.
- **short:** sells on every level above (perpetuals).
- **neutral:** both (perpetuals).

**Answering fills.** Every filled grid order is answered one level away:

- a buy at level _i_ gets a sell at _i + 1_;
- a sell at _i_ gets a buy at _i − 1_.

**Order names.** Answers are idempotent by clientOrderId:

| clientOrderId      | Meaning          |
| ------------------ | ---------------- |
| `g-{grid}-{level}` | starting order   |
| `gx-{order}`       | closes a round   |
| `go-{order}`       | re-opens a round |

A crash or a double run therefore never places an answer twice.

**Spot fees.** Spot buys receive the base asset minus the fee, so the
answering sell is the base actually received, rounded down to lots.

**When the grid stops.** If a grid order is cancelled, rejected or expires
outside the grid (for example by a manual cancel, or by self-trade
prevention against the owner's own order), the grid stops with the reason
and cancels what it left resting. Positions and balances it built stay with
the owner.

**Results.** `completedRounds` counts filled closing orders. `gridProfit` is
the gross profit of those rounds at grid prices: level step × size, in the
quote asset, **before fees**. It is labelled that way everywhere.

### Grid marketplace

**Listing.** A grid owner can list a grid (`isPublic`, or
`POST /v1/algo-orders/:id/visibility`).

**`GET /v1/grids/public`** is public. It shows:

- the parameters;
- the status and running time;
- the rounds and gross profit;
- the number of copies.

It **never** shows the owner. Grids are ranked by completed rounds.

**Copying.** `POST /v1/grids/:id/copy {quantityPerGrid}` starts the same
range, count and direction at the caller's own size. It is gated as `open`,
like any new risk. No fees or profit share flow to the original owner.

### Polling

Trailing, chase and grid orders are evaluated on every algo poll
(`ALGO_POLL_MS`, 1 s by default). After each step they go to the back of the
queue, so scheduled TWAP slices are never starved.

## Consequences

- **Reaction time.** Trailing and chase react within one poll (about 1 s),
  plus engine and settlement time. That is slower than an in-engine order
  type; it is the price of keeping the engine unchanged.
- **Grid stepping cost.** Each grid step reads all of the grid's children.
  Very long-running grids will need a cursor or a summary table.
- **A crash mid-start.** If a grid crashes in the middle of placing its
  starting orders, it continues with the orders that were placed.
- **Profit is gross.** Grid profit is before fees, and it does not include
  the open position's unrealised PnL.
