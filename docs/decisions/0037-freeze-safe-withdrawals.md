# ADR-0037: Freeze-safe withdrawals

- Status: Accepted (2026-11-10)
- Context: the internal review (`docs/security/internal-review-2026-11.md`,
  findings F-1 and F-2) showed two ways a frozen vault could owe more than
  it holds.

## Decision

### Contract

`escape` and `escapeDeposit` net a user's withdrawals against the frozen
root once, across both calls (`escapeNetted`). The total paid is the
committed balance plus post-root deposits, minus those withdrawals, never
below zero, in any order. ADR-0014's description of `escapeDeposit` changes
accordingly.

### Backend

- **Which roots are checked:** a freeze would leave the vault on root
  F ∈ {afterState − 1, afterState}. Roots older than the contract's
  `stateIndex` at the indexed (confirmed) block are excluded, because that
  index never goes back.
- **User withdrawal:** for each F, the amount must satisfy
  `amount ≤ leaf_F(wallet) + deposits after F(wallet) − withdrawals at {F, F+1}(wallet)`.
  The withdrawals counted are signed or executed; released ones are not.
  - The check runs under a per-wallet advisory lock, so parallel requests
    cannot both pass.
  - Refused with 409: "At most X can be withdrawn right now. Recent trading
    gains become withdrawable after the next on-chain state commitment."
- **Treasury withdrawal:** for each F, the amount must satisfy
  `amount ≤ vault balance at the indexed block − open signed withdrawals − Σ wallets (leaf_F + deposits after F − withdrawals at {F, F+1})`.
  It is checked when the request is made and again, under a lock, when it is
  signed.

## Consequences

- **Deposits can be withdrawn at once.** Trading gains wait for the next
  committed root: `VAULT_STATE_INTERVAL_SECONDS` plus the confirmations.
- **Fee revenue can be withdrawn once a root after the fees is confirmed.**
- **The contract changed,** so existing deployments must be redeployed.
