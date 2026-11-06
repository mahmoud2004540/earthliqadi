# ADR-0016: Real markets only — paper trading retired, perpetuals on vault collateral

- Status: Accepted
- Date: 2026-11-06
- Supersedes: the paper-only rule of ADR-0011 and the product role of ADR-0010
- Context: product brief rev 2 (`docs/product/product-brief.md`). The owner
  wants real spot and real perpetuals for professional traders, and no paper
  trading anywhere in the product.

## Decision

### 1. Paper trading is retired

Existing paper rows stay as immutable history; nothing new is created.

- The database refuses inserts of paper assets and paper markets
  (`*_no_new_paper` triggers) and `PAPER_FAUCET_GRANT` journal entries.
- Existing paper markets are halted.
- The faucet endpoint (`POST /v1/paper/faucet`) and all paper UI are removed.
- Paper assets and markets are no longer listed. The namespace-isolation
  triggers and the reconciliation check from ADR-0010 stay, so old history
  can never mix with real balances.

### 2. Perpetuals settle on real collateral

- `markets_perp_paper_only_chk` is dropped. Derivative ledger accounts
  (`USER_MARGIN`, `PERP_CLEARING`, `INSURANCE_FUND`, `PERP_FUNDING_POOL`) are
  allowed for real assets.
- **Quote asset:** outside local/ci, a perpetual's quote asset must be
  vault-backed (an on-chain token). Margin, PnL and funding therefore live in
  balances that every user can claim on-chain through the escape hatch
  (ADR-0014).
- **Risk rules:** all risk rules from ADR-0011 apply unchanged:
  - tiers, price bands, bankruptcy-capped closes;
  - zero-sum funding, liquidation, reconciliation.

### 3. Index sources

| Type        | Where allowed                                                                  |
| ----------- | ------------------------------------------------------------------------------ |
| `spot`      | everywhere (mid or recent last trade of a market here)                         |
| `oracle`    | everywhere a chain is configured: Chainlink-compatible `AggregatorV3Interface` |
| `simulated` | **automated tests only** (refused unless `DEPLOY_ENV` is local/ci)             |

Rules for oracle reads:

- A failed read, a non-positive answer, an incomplete round
  (`answeredInRound < roundId`) or a stale `updatedAt` produce **no price**.
- Without enough sources the index pauses, and with it funding, liquidations
  and risk-increasing orders. A value is never guessed.
- `TestPriceFeed.sol` exists only to exercise this path on local chains. On
  public testnets, staff configure real feeds through the admin API.

### 4. Insurance fund from fees

`insurance_fund.seed` (maker-checker) now moves collected `FEE_REVENUE` into
`INSURANCE_FUND`.

- The fund only ever holds real fee income and liquidation fees.
- Nothing is minted.
- The ledger refuses a top-up larger than the collected fees.

### 5. Default markets

`chain deploy` creates the test tokens and the vault, plus `TBTC-TUSD`
(spot) and `TBTC-TUSD-PERP`, whose index is the spot mid.

The market DTO exposes `vaultBacked`, and the terminal labels such markets
"Self-custody".

## Consequences

- Every balance a user trades with is backed by tokens in the vault contract.
  Until the external items in `production-readiness.md` are done, that
  contract runs only on a test chain.
- Test fixtures still use simulated custody and simulated index feeds. Both
  are refused outside local/ci by configuration and validation.
- **External and not claimed:** real-money derivatives are regulated in most
  jurisdictions, so counsel review is required before mainnet. The contract
  audit is also still outstanding.
