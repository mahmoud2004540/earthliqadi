# ADR-0020: Large-trader tools (TWAP, iceberg, RFQ block trades) and public proof of funds

- Status: Accepted (product step E)
- Date: 2026-11-07
- Context: product brief §3c. Large traders need to execute size without
  moving the price, and they need to trust a venue with large balances.

## Decision

### 1. TWAP and iceberg (`/v1/algo-orders`)

A parent order never holds funds. Each slice is an **ordinary child order**
with its own hold, risk checks, engine processing and settlement, so a
parent can never spend more than the account has.

**TWAP.** One IOC limit child per `intervalSeconds` (5 s to 1 day), at no
worse than the parent's price. It runs until the total is filled or every
slice was sent. Slices the market could not fill are not retried.

**Iceberg.** One visible GTC limit child at a time. When the child ends, the
next one is placed, until the total is done.

**Mechanics:**

- Slices are claimed with a compare-and-set on `slices_sent`, so two API
  instances can never send the same slice. Children link to the parent
  through `orders.algo_order_id`.
- If a child is refused (insufficient funds, halted market, risk limit), the
  parent stops as FAILED and records the reason.
- Cancelling the parent cancels its open child.

**Limits:** 20 running parents per account and 1000 slices per parent. The
scheduler runs every `ALGO_POLL_MS`.

### 2. RFQ / block trades (`/v1/rfq`)

**Who quotes.** Makers are registered by staff (`markets:configure`,
step-up, audited). The rules are public and the same for every maker.

**The flow:**

1. A trader requests a size on a market. The request is valid for 60 s.
2. Registered makers see open requests from other groups and quote a price,
   valid for 15 s.
3. The trader accepts a quote.

**Executing an accepted quote.** In one database transaction:

- the request is claimed (single use);
- both sides are placed as ordinary FOK limit orders with their normal holds
  and checks;
- one engine **`block`** command is enqueued.

**The engine `block` command:**

- **What it fills:** the two orders fill against each other only, at the
  quoted price and size.
- **Book and stops:** the resting book is untouched, and the last trade price
  does not move, so stops are not triggered.
- **Validation:** same price, same size, both FOK limits, different accounts
  and fresh ids. Anything else is rejected on both sides.
- **Recording:** the trade is printed to the tape and settled by the normal
  path, and it is part of the replayable engine history.

**Price band.** The block price must be within the market's price band
around the mark (perpetuals) or 5% of the book mid or last trade (spot).
This is checked when quoting and again when accepting. Without a reference
price, block trades pause.

**No self-dealing.** A maker never sees or quotes requests from its own
self-trade-prevention group.

### 3. Public proof of funds (`GET /v1/vault/solvency`, web `/proof`)

For each vault token, the endpoint reports:

| Field                  | Meaning                                                 |
| ---------------------- | ------------------------------------------------------- |
| `onChainBalance`       | Read live from the token contract; anyone can verify it |
| `committedLiabilities` | Sum of every leaf in the latest committed Merkle root   |
| `userBalancesNow`      | What the ledger owes users now                          |
| `custodyLedger`        | The ledger's mirror of the contract balance             |
| `committedCovered`     | `onChainBalance ≥ committedLiabilities`                 |
| `ledgerMatchesChain`   | `custodyLedger = onChainBalance`                        |

The `/proof` page shows these values. It also shows the signed-in user's own
leaf and Merkle path, which is everything needed for the escape hatch.

**Tested:** against the local chain, after a leader-vault commit, the
contract holds exactly what the root promises.

## Not done (and not claimed)

- **Cross margin and portfolio margin** (spot holdings offsetting perp risk)
  and **multi-collateral with haircuts** need a new account-level risk
  engine. That engine needs its own design, simulation and audit. Perpetuals
  stay isolated-margin.
- **Execution quality** of TWAP/iceberg is basic: no randomised slice sizes,
  no participation-rate mode, no slippage protection beyond the limit price.
- **Maker programme terms** (who qualifies, any obligations) are a business
  decision. The code only enforces registration.
