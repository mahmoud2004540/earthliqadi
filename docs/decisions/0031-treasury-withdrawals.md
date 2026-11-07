# ADR-0031: Treasury withdrawals of fee revenue

- Status: Accepted (owner request, 2026-11-07)
- Date: 2026-11-07
- Extends: ADR-0012 (maker-checker), ADR-0014 (vault), ADR-0015 (signer)

## Context

Fees are recorded in `FEE_REVENUE`, but the tokens stay in the vault
contract next to customer funds. The owner needs to take revenue out without
any path that could reach customer balances. The owner chose this route:

**platform → own treasury wallet (ideally a multisig) → exchange account**

## Decision

### The treasury wallet

`TREASURY_ADDRESS` is the treasury wallet. It is set only in the server
configuration. Nothing in the admin console can change it, so a compromised
staff account cannot redirect revenue. When it is empty, treasury
withdrawals are disabled.

### The withdrawal flow

A treasury withdrawal is the maker-checker action `treasury.withdraw
{asset, amount}`:

- **Who can request it:** staff with `ledger:adjust`.
- **Who can approve it:** a different staff member with the same
  permission.

**Before the request is accepted, the server checks that:**

- the wallet is configured;
- the asset is held in the vault;
- the amount is at most the collected `FEE_REVENUE`.

**On approval:**

1. The amount moves `FEE_REVENUE` → `TREASURY_WITHDRAWING`, a new system
   account. `FEE_REVENUE` cannot go negative, so customer balances and the
   insurance fund are unreachable by construction.
2. The operator signs a normal vault withdrawal to the treasury wallet. The
   signer service's per-transaction and daily limits apply to it as to any
   withdrawal.
3. The process relays the withdrawal on-chain when it holds a sending key.
4. The indexer finalises it from the `Withdrawn` event:
   `TREASURY_WITHDRAWING` → `VAULT_CUSTODY`.
5. If it expires unexecuted, the hold returns to `FEE_REVENUE`.

**Idempotent:** at most one withdrawal per approval, enforced by a unique
index.

**Database rules:** the `withdrawals` row has no customer (`user_id` null,
`is_treasury`, `approval_id`). A CHECK ties these three columns together.

**Records.** Every step is audited (`treasury.withdrawal.signed`, plus the
approval trail). The admin console's Treasury tab shows:

- the configured wallet;
- fee revenue and amounts being withdrawn, per asset;
- the withdrawal history.

## Consequences

- **The vault always still covers every customer balance.** Only revenue
  leaves; custody reconciliation and the proof of funds are unchanged.
- **With the remote signer and no sending key,** the signed withdrawal must
  be relayed by hand. Anyone can relay it, and funds can only reach the
  treasury. A relay button is future work.
- **The wallet itself.** It should be a multisig or hardware wallet the
  owner controls. Moving funds on to an exchange account is a separate,
  manual step. Revenue should go to a company account, with an accountant.
