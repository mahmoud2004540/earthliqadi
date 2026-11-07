# ADR-0028: Account overview and statements (banking-grade account experience)

- Status: Accepted (owner, 2026-11-07: Phase A of the trusted-exchange
  strategy; interface stays English-only)
- Date: 2026-11-07

## Context

Customers keep funds where they understand them: a total, where each
balance is held, and records they can keep. The platform stays
non-custodial (ADR-0013, ADR-0014). These features need no licence, and
they must not imply bank-like protection.

## Decision

### Account overview

`GET /v1/me/overview` returns, for every non-zero balance:

- **The balance:** available, locked (open orders), margin and total;
- **custody:** `vault` (backed by the vault contract, claimable with a
  balance proof) or `ledger` (platform-only test assets);
- **an indicative value** in `VALUATION_ASSET` (default `USDC`).

**How assets are valued:**

- **The valuation asset** itself counts 1:1 (`reference`).
- **Other assets** are valued at the last trade of their **active spot
  market** against the valuation asset (`last_trade`). The market used is
  returned.
- **Assets with no such market or no trade yet** are listed as `unvalued`
  and left out of the total. **They are never estimated.**

`totalValue` is the sum of valued balances plus the unrealised PnL of open
perpetual positions settled in the valuation asset. All arithmetic is exact
decimal.

**What the dashboard shows:**

- the total first, with "valued at last traded prices" and a timestamp;
- a "held in" chip on every balance;
- a fixed disclosure: balances are not bank deposits and have no deposit
  insurance or government guarantee, and values are indicative.

## Consequences

- **Prices are last trades.** On thin markets the value can be stale. The
  UI states the basis and does not present it as a quote.
- **One currency only.** Fiat valuation (ILS, EUR) would need a reliable FX
  source. It is not shown until one is integrated; no rate is invented.
