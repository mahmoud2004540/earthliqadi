# ADR-0019: Leader vaults (copy-trading)

- Status: Accepted (product step D)
- Date: 2026-11-06
- Context: product brief §3b. Leader vaults are the growth feature: skilled
  traders bring their audience, and followers get a verifiable record and
  can leave at any time.

## Decision

### 1. Structure

**The vault account.** A vault has its own credential-free trading account
(`users.is_vault`, owned by the leader as `parent_user_id`).

- **Who trades it:** the leader trades it with `X-Sub-Account`, which is
  restricted to the trading and read allow-list.
- **What it trades:** **perpetual markets of the vault's collateral asset
  only.**
- **How money moves:** the leader can never transfer from it. Sub-account
  transfers refuse vault accounts, and withdrawals are not on the allow-list.
  Money enters only as deposits and leaves only as redemptions paid to share
  holders.

**Self-dealing.** One self-trade-prevention account per parent:
`orders.engine_account = COALESCE(parent_user_id, id)`. As a result, a leader,
their sub-accounts and their vaults never match each other; the engine
cancels the taker. Liquidation orders keep the user's own id, so a resting
order in a related account can never block a liquidation.

### 2. Shares

**Pricing.** Equity = vault balances in the collateral asset + unrealised PnL
of its positions **at mark**.

- **Deposits** mint `amount × totalShares / equity` shares, rounded down so
  existing holders are never diluted (property-tested).
- **No reliable mark:** deposits and payouts wait until one is available.

**Profit share.** Charged only on the gain above each holder's **high-water
mark** (set at deposit, share-weighted on top-ups, raised when profit share
is taken). Rules:

- never charged on the leader's own shares;
- paid to the leader's main account at redemption;
- `profit_share_bps` ≤ 30%.

**Leader's minimum share.** The leader keeps ≥ `min_leader_share_bps`
(default 5%) of the vault while others hold shares. Follower deposits that
would break this are refused, and so are leader redemptions while others
hold shares.

**Fixed terms.** A trigger blocks changes to the profit share, minimum
share, owner, account and asset. Limits (leverage, drawdown) may only
become stricter.

### 3. Exits are never refused

**Payout.** A redemption is paid immediately when the vault's free
collateral covers it.

**Queueing.** Otherwise it is queued (`vault_redemptions`, paid first in,
first out). While anything is queued, the vault accepts **only reduce-only
orders**, so the leader has to free collateral. Queued shares still count in
the share total, so the holder keeps bearing the vault's results until paid.

**Margin cap.** A vault may not use more than 80% of its equity as margin, so
some free collateral normally exists.

### 4. Risk limits

- **Leverage:** the vault's maximum leverage is enforced on leverage changes
  and on orders.
- **Drawdown halt:** the vault tick tracks the peak price per share. Beyond
  `max_drawdown_bps` the vault is HALTED, accepting only reduce-only orders
  and no deposits, until it recovers.

### 5. Track record and leaderboard

**Snapshots.** `vault_snapshots` stores equity, total shares and price per
share at each tick. All values are derived from the ledger and marks, with
no manual input.

**Public data:**

- `GET /v1/leader-vaults`: ranked by return since inception ÷ max(max
  drawdown, 1%), **not** raw return;
- `GET /v1/leader-vaults/:id`: share-price curve, return since inception,
  30-day return, max drawdown, terms, holders.

### 6. The escape hatch covers followers

When the balance root is committed, the vault account is excluded from the
leader's leaf. Each of the vault's token balances is attributed **pro rata
to its share holders**, queued redemptions included, and added to each
holder's own wallet leaf. Rounding dust stays unattributed. If the operator
disappears, every follower claims their part on-chain.

This is tested against the local chain: leader 100 + follower 300 in the
vault; each leaf equals own balance + pro-rata vault share, and the vault
has no leaf of its own.

## Not done / not claimed

- **Escape-hatch pricing:** escape-hatch shares use ledger balances, with
  no unrealised PnL, because positions cannot settle on-chain.
- **No forced pro-rata unwinding:** queued exits rely on the reduce-only block
  to make the leader free collateral; no automatic pro-rata position
  reduction exists yet.
- **Regulation:** copy-trading with profit share may be regulated as
  investment management. Counsel review is required before mainnet.
