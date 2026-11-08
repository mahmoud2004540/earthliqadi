# ADR-0032: Open-interest caps and lessons from public perp-DEX incidents

- Status: Accepted
- Date: 2026-11-08
- Context: the owner asked which incidents hurt Hyperliquid, and to make
  sure the same thing cannot happen here.

## Context

Two widely reported incidents on Hyperliquid in March 2025 are useful test
cases. This summary is from public reporting, not from our own
investigation.

1. **The large ETH long.** A trader opened a very large leveraged position,
   then withdrew margin until it was close to liquidation. The liquidation
   passed the position to the venue's liquidity vault (HLP), which closed it
   at a loss of a few million dollars. Hyperliquid then raised the margin a
   withdrawal must leave behind and lowered maximum leverage.
2. **A thinly traded token (JELLY).** A large short was self-liquidated into
   the same vault. The token's price was then pushed up on other venues,
   leaving the vault with a growing loss. Validators delisted the market and
   settled it at a chosen price. That stopped the loss, but it was widely
   criticised as a discretionary intervention.

Both incidents need the same ingredients: a position large relative to real
liquidity, and a backstop that must absorb it.

## Where this exchange already stands

| Ingredient                                            | Here                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A backstop vault that takes over liquidated positions | **None.** Liquidations sell into the order book, protected at the bankruptcy price (ADR-0011). Insurance-fund takeover and ADL are not live.                                                                                  |
| Withdrawing margin from an open position              | **Not offered** (ADR-0011). Unrealised profit is never withdrawable. Cross mode only adds free balance to a position (ADR-0021).                                                                                              |
| A mark price that a single venue can push             | The index is the median of several sources after outlier rejection. The mark is clamped to `maxBasisBps` around it. The last trade is never used for liquidation. Without a fresh mark, only reduce-only orders are accepted. |
| One very large position                               | Risk tiers. The largest tier's `maxNotional` is the per-position maximum, and leverage falls as size grows.                                                                                                                   |
| Trading against your own vault or sub-account         | Self-trade prevention per parent account (ADR-0019).                                                                                                                                                                          |
| Ad-hoc settlement at a chosen price                   | No such tool exists. A market can be halted (cancels still work), and every halt is audited.                                                                                                                                  |

The missing piece was a **market-wide** limit. Without KYC, one person can
open many wallets, so a per-position cap alone does not bound total exposure
in a thin market.

## Decision

`perp_config.maxOpenInterest` (optional, in quote units at the mark price) is
a market-wide open-interest cap.

- **What it measures:** open interest is the total size of open long
  positions (equal to the shorts), valued at the current mark. The order's
  limit price is used only when there is no mark.
- **What it refuses:** an order that would enlarge the user's position,
  checked in the order transaction. It is refused when open interest plus that
  enlargement would exceed the cap: `409 LIMIT_EXCEEDED`, with nothing held.
  The whole enlargement is counted, which is conservative, because a fill
  against someone closing adds no open interest.
- **What it never blocks:** reducing or closing a position, at any level of
  open interest.
- **Setting it:** at market creation, or later with
  `PATCH /v1/admin/markets/:symbol/open-interest-cap {maxOpenInterest: "…" | null}`
  (`markets:configure`, step-up). Every change is audited with the old and new
  values.
- **Shown to users:** `GET` perp stats returns `openInterest` and
  `openInterestNotional`, and the market DTO returns `maxOpenInterest`. The
  terminal shows "Open interest" as `current / cap`.

### Operating guidance

- Set the cap from **real external liquidity**, not from demand. For example,
  a small multiple of the depth within 2% on the main external venues. Thin
  or newly listed markets get a low cap and low leverage tiers.
- Lowering the cap below current open interest is allowed. It simply stops
  growth until positions close.

## Limits (not claimed)

- **Resting orders:** the check runs at placement. Opening orders that were
  already resting can still fill after the cap is reached. They remain bound
  by the price band and the position tiers.
- **Concurrent orders:** two orders checked at the same moment can each pass,
  so the cap can be exceeded by at most the size of orders placed in parallel.
  Serialising on a market lock would break the global lock order (positions →
  ledger → market sequence).
- **Automatic caps:** caps are not yet derived automatically from external
  order-book depth.
- **Partial liquidation:** large positions are not yet liquidated in slices.
  A liquidation is one IOC order retried each tick.
- **No backstop:** without a backstop or ADL, an unfilled liquidation waits
  for liquidity. This is documented in ADR-0011 as required before
  real-money derivatives.
