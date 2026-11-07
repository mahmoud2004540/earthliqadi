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

### Statements

`GET /v1/me/statements?period=YYYY-MM|YYYY` (UTC) builds a statement from
the double-entry ledger. `GET /v1/me/statements.csv` returns the same
statement as a download.

**Per asset:** opening total, money in, money out and closing total, where
the total is all of the account's buckets together.

**The lines:** every journal entry that changed that total, with its time,
type and signed change. Entries that only move funds between the account's
own buckets (order holds, margin) net to zero and are left out.

**The CSV:**

- states that it is not a bank statement;
- quotes every field;
- neutralises spreadsheet formulas in text fields.

**Limit:** a statement carries at most 10 000 lines. Longer periods are
flagged as truncated, and the user is asked to choose a month.

The dashboard's Statements tab lists the last 12 months and the current and
previous year.

## Consequences

- **Prices are last trades.** On thin markets the value can be stale. The
  UI states the basis and does not present it as a quote.
- **A statement is not a tax report.** Statements list movements; they do
  not compute cost basis or gains, and they are not in ILS.
- **One currency only.** Fiat valuation (ILS, EUR) would need a reliable FX
  source. It is not shown until one is integrated; no rate is invented.
