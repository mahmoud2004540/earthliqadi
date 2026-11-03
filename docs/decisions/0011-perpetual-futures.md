# ADR-0011: Perpetual futures (paper only), margin, funding and liquidation

- Status: Accepted
- Date: 2026-11-03
- Phase: 6

## Context

Phase 6 adds linear perpetual futures and risk simulation. Leverage is the
riskiest part of an exchange: errors lose more than a user deposited and can
leave the venue insolvent. Real-money derivatives also need separate
authorisation in almost every jurisdiction. So perpetuals start in simulation.

## Decision

### Paper only, enforced by the database

- `markets.kind` is `SPOT` or `PERPETUAL` and is immutable.
  `markets_perp_paper_only_chk` makes a non-paper perpetual impossible.
- The derivative ledger account types (`USER_MARGIN`, `PERP_CLEARING`,
  `INSURANCE_FUND`, `PERP_FUNDING_POOL`) can only be created for paper assets
  (`ledger_accounts_check_namespace` trigger).
- Lifting this requires a new ADR, legal sign-off and a migration. No
  configuration flag can do it.

### Contract

- Linear, quote-margined (for example `PBTC-PUSD-PERP`). The base asset only
  gives the quantity units; no base asset ever moves.
- The matching engine is unchanged: it matches prices and quantities, so spot
  and perpetual books share the same deterministic engine, replay and
  `engine-replay` gate (ADR-0007, ADR-0010).
- Every perpetual order needs a price (a limit price, or a protection price
  for market orders on both sides), within `priceBandBps` of the mark price.

### Positions and accounting

One isolated-margin position per user and market: signed size (lots), signed
entry notional, margin and leverage. A fill is split into a closing part and
an opening part (`applyFill`, `perp-math.ts`):

- closing `c` of `|S|` lots removes `r = E·c/|S|` of entry notional, realises
  `pnl = −sign(dq)·N_close − r`, and releases the same share of margin;
- opening adds `sign(dq)·N_open` to entry and moves initial margin
  (`ceil(N_open / leverage)`) from the order hold to `USER_MARGIN`.

Identity: for every fill, `Δentry − pnl = sign(dq)·N`. The buyer and seller
have opposite signs, so per market Σ open entry notional = Σ realised PnL.
`PERP_CLEARING` pays out realised PnL, so **its balance always equals Σ open
entry notional**. Reconciliation checks this exactly
(`PERP_CLEARING_MISMATCH`), along with:

- Σ position margin = `USER_MARGIN` per user and asset
  (`POSITION_MARGIN_MISMATCH`);
- net open interest = 0 per market (`OPEN_INTEREST_IMBALANCE`);
- funding pool = Σ(collected − distributed) (`FUNDING_POOL_MISMATCH`).

The database adds `positions_flat_chk` (a flat position has no entry and no
margin), `positions_entry_sign_chk`, and non-negative margin.

### Orders

- Hold = initial margin at the order's leverage plus the maximum fee.
  Reduce-only orders hold only the fee.
- Checks run inside the order transaction with the position row locked. Global
  lock order: position → ledger accounts → market sequence (settlement and
  funding lock positions first too).
  - A liquidating position blocks new orders.
  - Reduce-only quantity must not exceed the position minus pending
    reduce-only orders.
  - A closing order may not be priced beyond the bankruptcy price.
  - The projected position must fit a risk tier allowing the leverage.
- Without a fresh mark price only reduce-only orders are accepted.
- Leverage changes only while flat with no open orders. Margin can be added
  (`POST /v1/perp/margin`); removing margin is not offered yet.

### Risk tiers

Tiers set `maxNotional`, `maxLeverage` and the maintenance margin rate. They
are validated so that maintenance margin is always below initial margin
(`mmrBps × maxLeverage < 10000`), and larger tiers never allow more leverage
or a lower maintenance rate.

### Index and mark price

- Index = median of fresh sources after outlier rejection (`outlierBps` from
  the median). It is unavailable if fewer than `minSources` remain.
- Sources:
  - `spot`: the mid price of a spot market on this exchange with the same
    assets, or a recent last trade;
  - `simulated`: a deterministic random walk, **labelled "SIMULATED … not a
    real price"** in the API and UI. External price feeds come with
    integrations (Phase 8).
- Mark = index + EMA of (perp mid − index), clamped to `±maxBasisBps`. **The
  last trade price is never used for liquidation.** A thin or manipulated
  perpetual book can move the mark by at most `maxBasisBps`.
- Samples are append-only (`perp_price_samples`). Without a fresh sample the
  mark is unavailable. Funding, liquidations and risk-increasing orders then
  pause, and the UI says so.

### Funding

- At each interval boundary: rate = mean premium of the interval, clamped to
  `±fundingClampBps`. A positive rate means longs pay shorts.
- Payers pay `ceil(notional × rate)`, capped at their margin. Receivers share
  what was actually collected, rounded down, so the result is zero-sum up to
  dust that stays in `PERP_FUNDING_POOL`.
- One ledger entry per round, keyed `funding:<market>:<time>`, plus an
  append-only `perp_funding_rounds` row. Settling the same round twice is a
  no-op.

### Liquidation

When equity (margin + unrealised PnL at mark) falls below the maintenance
margin:

1. The position becomes `LIQUIDATING` (new orders blocked; audited) and its
   open orders are cancelled.
2. Once no order remains, an IOC reduce-only market order for the whole
   position is placed, **protected at the bankruptcy price**. Its fill can
   never realise more than the margin. The liquidation fee
   (`liquidationFeeBps`, capped by what is left) goes to `INSURANCE_FUND`, and
   any remainder goes back to the user.
3. Unfilled remainders retry on the next tick. A position that recovers above
   maintenance before step 2 returns to `NORMAL`.

Settlement still handles a loss beyond margin (rounding, or a reduce-only
race): first from the position's remaining margin, then from the insurance
fund. If the fund is insufficient, the ledger refuses the posting and that
market's settlement halts for investigation. Losses are never silently
written off.

### Not live: backstop and ADL

Insurance-fund takeover and auto-deleveraging are **not live**. ADL ranking
(PnL ratio × effective leverage) and the deficit cascade (insurance fund,
then ADL, then counterparty) are specified in the simulation harness
(`risk-sim.ts`). Its property test proves value conservation and that no
liquidated trader goes below zero on random synthetic paths.

## Consequences

- Leverage, funding and liquidation run through the same ledger and
  reconciliation as spot, with exact integer arithmetic.
- The risk engine runs in the API process on a timer (`PERP_RISK_POLL_MS`).
  Row locks and idempotency keys make concurrent ticks safe. A dedicated risk
  service process is a later scaling step.
- Before any real-money derivatives:
  - live ADL and a backstop;
  - external index feeds with signed data;
  - margin removal and cross margin;
  - per-tier position limits enforced on mark-to-market;
  - independent review of this ADR.
