# ADR-0027: Multi-collateral by auto-conversion

- Status: Accepted (product brief §3, item 10)
- Date: 2026-11-06
- Extends: ADR-0021 (cross margin)

## Context

Large traders hold assets other than the quote currency and want those
holdings to stand behind their perpetual positions.

**What the textbook design needs.** Margin counted directly in many assets
needs three things:

- an account-level risk engine;
- loans against collateral, with debt accounting;
- valuing collateral inside the on-chain proof of funds.

**Why that is risky here.** A quote "credit" that is not backed by quote
tokens in the vault could be withdrawn, and that would make the vault
insolvent. That design is not safe without a full lending model.

## Decision

Margin stays in the quote asset. The vault, ledger, merkle balance roots and
proof of funds are unchanged.

**Opting in.** Accounts opt in (`POST /v1/perp/collateral {enabled}`,
audited). The setting works only in cross mode. Vault accounts cannot opt
in.

**What happens on the risk tick.**

1. **Cross top-up runs as before.** Free quote moves into a position whose
   equity is below 125% of maintenance (ADR-0021).
2. **What is still missing is the shortfall.** It is the amount needed to
   bring that position back to its initial margin at mark.
3. **Collateral is sold for the shortfall.** The system places one IOC sell
   of an accepted collateral asset on its spot market:
   - **Order of assets:** lowest haircut first.
   - **Size:** the shortfall, grossed up by the taker fee, rounded up to
     lots, at least the market minimum, at most the free balance.
   - **Worst price:** the floor, which is the best bid minus the asset's
     haircut.
4. **Proceeds back the position.** They reach the free quote balance at
   settlement. The next tick's cross top-up moves them into the position.

**Guards:**

- one conversion in flight per account;
- never for a sanctioned wallet (ADR-0022);
- every conversion is audited (`perp.collateral.conversion`).

**Liquidation is not delayed** while a sale settles. Conversion starts at
125% of maintenance, which leaves a buffer before liquidation at 100%. If
the market moves faster than the sale, liquidation proceeds exactly as
before. A position is never kept open on value that has not been realised.

**Accepted assets.** Staff decide which assets are accepted, through
`POST /v1/admin/collateral-assets` (`markets:configure` + step-up, audited).
Each accepted asset needs:

- **its spot market:** the asset / quote spot market that converts it;
- **a haircut:** 1%–50%, enforced by a database check.

The haircut is both the value discount shown to users and the worst
conversion price. The list is public at `GET /v1/perp/collateral-assets`.

**What users see.** `GET /v1/perp/collateral` shows each asset with:

- the free balance;
- the best bid;
- its value after the haircut.

## Consequences

- **Opening positions still needs quote.** Collateral defends positions; it
  does not fund new ones. Funding new positions from collateral would need
  the lending model above, which is not built and not claimed.
- **Fees.** Conversions pay the spot taker fee, and that fee is sized into
  the sale.
- **Thin books.** A conversion fills only down to the floor price. On a thin
  book it can fill partly or not at all, and liquidation then follows the
  normal path.
- **Portfolio margin remains open work.** Offsetting risk across positions
  and spot holdings needs the account-level risk engine.
