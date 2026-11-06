# Product brief: non-custodial perpetuals exchange

- Status: Draft for owner review
- Date: 2026-11-06
- Direction chosen by the owner: a non-custodial perpetuals venue in the
  style of Hyperliquid (wallet sign-in, no account creation, no identity
  verification — ADR-0013), with one feature that gives traders a reason to
  come here.

## 1. Goal

Traders sign in with a wallet, deposit collateral into the vault contract,
and trade perpetual futures with leverage. **They can always withdraw**, even
if the operator disappears (escape hatch, ADR-0014).

The platform succeeds when real traders keep collateral on it and come back
to trade. Visitors alone do not count.

## 2. Who it is for

1. **Active perp traders** who already use centralised exchanges, do not want
   to hand over custody, and do not want to fill in KYC forms.
2. **Skilled traders with an audience** (a Telegram channel, X, YouTube) who
   want to earn from their skill without asking followers to send them money.
3. **Followers** who want exposure to a trader they trust, can see that
   trader's real record, and can leave at any time.

## 3. The feature that brings traders: leader vaults (copy-trading)

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

1. **Perpetuals on real vault collateral (testnet).**
   - **Today:** perps are paper-only (ADR-0011).
   - **Needed:** margin in the vault's stable token, and a live insurance
     fund.
   - **Unchanged:** price bands, liquidation and funding rules.
2. **Leader vaults:**
   - share ledger accounts and DB invariants;
   - create, deposit, withdraw with the high-water-mark profit share;
   - leader trading on behalf of the vault, plus risk limits;
   - pro-rata exit.
3. **Public track record and vault pages:**
   - equity curve and stats computed from postings;
   - a leaderboard sorted by risk-adjusted metrics, not raw return.
4. **Leader invite links:** attribution of new wallets to a leader. No
   payouts until the owner decides on a referral policy.
5. **Per-follower proof page:** shows the follower's leaf in the committed
   state root, and how to use the escape hatch.
6. **Fee schedule:** maker/taker fees, the vault profit share and the
   platform fee, shown before every action.

## 7. What we remove or freeze

- **Spot markets:** these stay, but are not the product focus. No new spot
  features.
- **Paper trading:** kept only as a "practice" mode. It shares the same
  engine and is clearly labelled.
- **KYC module:** already off by default (ADR-0013). No further work.

## 8. Not done and not claimed

- Smart-contract audit, penetration test and legal analysis of a no-KYC
  perps venue with copy-trading.
- Sanctions screening contract, HSM/KMS.

Copy-trading with profit share can be regulated as investment management in
many jurisdictions. **Counsel review is required before mainnet.** Until
then, everything runs on a test chain only.
