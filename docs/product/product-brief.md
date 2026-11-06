# Product brief: non-custodial spot and perpetuals exchange

- Status: Draft for owner review (revision 2)
- Date: 2026-11-06
- Direction chosen by the owner: a non-custodial venue in the style of
  Hyperliquid (wallet sign-in, no account creation, no identity verification —
  ADR-0013) with **both real spot and real perpetuals**, built for
  professional traders, with leader vaults as the growth feature.
- Revision 2 (owner decision): spot is a first-class product, not frozen;
  **no paper trading anywhere in the product**; professional traders are a
  primary audience.

## 1. Goal

Traders sign in with a wallet, deposit collateral into the vault contract,
and trade **spot and perpetual futures** against real collateral. They can
always withdraw, even if the operator disappears (escape hatch, ADR-0014).

The platform succeeds when real traders keep collateral on it and come back
to trade. "Real" here means real code paths and real on-chain collateral;
until the external items in section 8 are done, the chain is a test chain.

## 2. Who it is for

1. **Professional and algorithmic traders** (spot and/or perps) who need an
   API, low latency, advanced order types, fair fees and deep books, and
   who want self-custody.
2. **Spot-only traders** who never use derivatives: they get a full spot
   venue with the same self-custody guarantees.
3. **Skilled traders with an audience** who run leader vaults.
4. **Followers** who allocate to leader vaults and can leave at any time.

## 3a. Professional trading (spot and perps)

| Capability                                      | Status today       | Needed                                                                                                                     |
| ----------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Limit/market, IOC/FOK/post-only, stop orders    | Exists             | Keep; add TP/SL attached to perp positions                                                                                 |
| REST + WebSocket market data                    | Exists             | Public order-book diff stream with sequence numbers                                                                        |
| API trading for bots                            | Session-based only | **Agent keys**: the wallet signs once to authorise an API key with scopes (trade only, never withdraw), expiry and IP list |
| Batch place/cancel, cancel-all, dead-man switch | Missing            | Add                                                                                                                        |
| Fee tiers by 30-day volume, maker rebates       | Missing            | Add, shown publicly; rebates paid from taker fees only                                                                     |
| Sub-accounts under one wallet                   | Missing            | Add (separate margin, one sign-in)                                                                                         |
| Market-maker programme                          | Missing            | Public, rule-based terms; no private deals hidden from users                                                               |

## 3b. The feature that brings traders: leader vaults (copy-trading)

A trader opens a **leader vault**, followers deposit into it, and the leader
trades the vault's collateral.

- **Profit share:** the leader earns a share of the profit, only above a
  high-water mark.
- **Leader capital:** the leader must keep their own capital inside the vault.
- **Track record:** the leader's record is computed from the ledger and the
  trade history. The leader cannot edit it or report it themselves.

Why it brings traders:

- **Distribution is built in.** Every leader has a reason to promote the
  platform to their own audience, because that is how they earn. Growth
  comes from leaders, not from a marketing budget.
- **Trust is provable.** Followers can check, on-chain, that their share
  exists (Merkle proof against the committed state root). They can withdraw
  without asking anyone. The record cannot be faked, because nobody,
  including the operator, can edit history (immutable ledger + engine
  replay).
- **It answers the usual copy-trading problems:**

  | Usual problem                 | How a leader vault answers it                   |
  | ----------------------------- | ----------------------------------------------- |
  | Fake screenshots of results   | Record comes from the ledger                    |
  | Leader can run with the money | Leader can trade, never withdraw others' shares |
  | Lock-ups                      | Followers exit whenever they choose             |
  | Leader takes fees on losses   | Profit share only above the high-water mark     |

### Rules (initial values, to be reviewed by the owner)

| Rule               | Initial value                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| Leader's own share | at least 5% of vault equity, enforced on follower deposits and leader withdrawals                          |
| Profit share       | 0–30%, set when the vault is created, never raised afterwards                                              |
| High-water mark    | per follower, profit share charged only on new highs, at withdrawal                                        |
| Follower exit      | any time; open positions are reduced pro-rata or the share is paid from free margin                        |
| Leader risk limits | max leverage and max drawdown set by the leader; on breach new orders are blocked                          |
| Shares             | fixed-precision share units in the ledger, value = vault equity / total shares                             |
| Track record shown | return since inception, max drawdown, 30/90-day returns, trade count, equity curve — all derived from data |

**Not claimed:** we do not promise returns, we do not rank leaders by
promised performance, and we do not publish any record that is not computed
from real trades.

## 3c. Large traders ("whales")

What large traders choose a venue for, and how we answer it without
fabricating anything:

| Need                                  | Answer                                                                                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execute size without moving the price | **TWAP** and **iceberg** orders (server-side, cancellable); **RFQ / block trades**: request quotes from registered makers, settle on the same ledger, printed to the tape after execution |
| Capital efficiency                    | **Cross margin**, then **portfolio margin** (spot holdings offset perp risk) with published haircuts; multiple collateral tokens with published haircuts                                  |
| Privacy                               | No account, no KYC (ADR-0013); sub-accounts to split strategies; no public mapping from wallet to identity                                                                                |
| Trust with large balances             | Self-custody vault, per-user Merkle proof, escape hatch, public live **proof-of-liabilities** (sum of committed leaves) against on-chain vault balances                                   |
| Fast exit                             | Withdrawals signed in seconds within signer limits; above limits a published, rule-based review window — never discretionary freezes                                                      |
| Fees                                  | VIP tiers by 30-day volume, maker rebates, all public                                                                                                                                     |
| Limits                                | High per-order and position limits per market, set by published risk tiers — the same rules for everyone                                                                                  |
| Direct support                        | A priority support channel for top tiers (response time, not special treatment on rules)                                                                                                  |

### Growth programmes (all public, rule-based)

- **Referral fee share.** A part of the taker fees paid by referred wallets
  goes to the referrer:
  - paid from real fees;
  - capped;
  - visible in the referrer's dashboard.
- **Leader vaults** (3b).
- **Points for real activity** (fees paid, maker volume, vault deposits),
  shown on a public, anti-wash-trading-filtered leaderboard.
  - **We do not promise a token or an airdrop.** If one is ever decided, it
    needs counsel review first.
  - Points from self-trades or wash trades are excluded: same wallet, linked
    sub-accounts, and detected circular flows.
- **New-market listings** driven by a public request-and-vote board. The
  listing decision stays with published risk criteria.

**Never:**

- fake volume, bots posing as users, or hidden fee deals;
- private rule exceptions for whales;
- guaranteed returns.

## 4. Success metrics

| Metric                                              | What it tells us             |
| --------------------------------------------------- | ---------------------------- |
| Weekly active trading wallets                       | Real use                     |
| Collateral in the vault contract (TVL)              | Trust                        |
| Number of leader vaults with followers              | The growth engine is working |
| Share of new wallets arriving through a leader link | Distribution through leaders |
| 30-day retention of depositing wallets              | People stay                  |
| Escape-hatch or reconciliation failures             | Must stay at zero            |

## 5. What exists today

Spot and perpetual matching, double-entry ledger, wallet sign-in, vault
contract with escape hatch, isolated signer, market data, admin console,
monitoring. These are listed in `docs/operations/production-readiness.md`.

## 6. What is missing for this goal (gap list, in build order)

1. **Remove paper trading from the product:**
   - remove the paper faucet, paper markets and the "practice" UI;
   - keep the database isolation code only as a migration that retires the
     namespace.
2. **Real spot on vault collateral as the default experience:**
   - every listed spot market is vault-backed;
   - deposit and withdraw in the terminal;
   - full order types.
3. **Real perpetuals on vault collateral:**
   - margin in the vault's stable token, live insurance fund, real funding;
   - the existing risk rules (price bands, liquidation, ADL harness) move
     over unchanged.
4. **Professional tooling:**
   - agent API keys (trade-only, wallet-authorised);
   - batch orders, cancel-all, dead-man switch;
   - WebSocket book diffs with sequence numbers;
   - TP/SL;
   - sub-accounts.
5. **Fee tiers and maker rebates,** published and shown before every action.
6. **Leader vaults:**
   - share accounting, high-water-mark profit share;
   - leader risk limits, pro-rata exit.
7. **Public track records and leaderboard,** derived from trades only.
8. **Leader invite links** (attribution only, no payouts yet).
9. **Per-user proof page:**
   - the user's leaf in the committed state root;
   - an escape-hatch guide.

10. **Whale tools:**
    - TWAP and iceberg orders;
    - cross margin, then portfolio margin;
    - multi-collateral with haircuts;
    - RFQ and block trades with registered makers.
11. **Growth programmes:**
    - referral fee share;
    - activity points with wash-trading filters;
    - listing request board.
12. **Public proof-of-liabilities page** against the on-chain vault
    balances.

## 7. What we remove

- **Paper trading:** removed entirely, at the owner's decision. This
  includes the faucet, paper perps and the practice mode.
- **KYC module:** stays off (ADR-0013).

## 8. Not done and not claimed

- **Not done:** smart-contract audit, penetration test, legal analysis
  (no-KYC spot and perps with copy-trading), sanctions screening, HSM/KMS,
  liquidity.
- **Liquidity:** we will not invent volume or fake order books. Liquidity
  comes from real makers under public terms.
- **Before mainnet:** counsel review is required. Until then, everything
  runs on a test chain.
