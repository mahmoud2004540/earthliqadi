# ADR-0033: Contract-level deposit cap (launch guard)

- Status: Accepted
- Date: 2026-11-09
- Context: the contract has not been audited yet. If a bug is found, the
  amount at risk should be limited by the contract itself, not by the backend.

## Decision

`ExchangeVault` keeps two values per token:

- `held[token]`: deposits minus payouts. It never goes below zero, and tokens
  sent to the vault without `deposit()` are not counted.
- `depositCap[token]`: the maximum `held`. `type(uint256).max` means no cap.

### Rules

- `deposit()` reverts with `DepositCapExceeded` when the received amount would
  push `held` above the cap. The check uses the amount actually received, so
  it also holds for fee-on-transfer tokens.
- `withdraw`, `withdrawAfterFreeze`, `escape` and `escapeDeposit` lower
  `held`. **They are never limited by the cap**: lowering the cap, even to
  zero, only stops new deposits. Every user can always leave.
- The constructor takes one cap per token (`BadConfig` if the lengths
  differ).
- `setDepositCap(token, cap)` is **operator only**. It emits
  `DepositCapChanged`.

### Why the operator, and not a separate admin key

The cap cannot move funds, and it cannot block an exit. The worst a stolen
operator key can do with it is raise or remove the cap. That key can already
sign withdrawals, so the cap gives it no new power. A separate admin key would
add a second key to protect and gain nothing.

### Changing the cap

- **Approval:** maker-checker approval action `vault.deposit_cap`, with the
  payload `{asset, cap | "unlimited"}`. It needs the `assets:configure`
  permission and two different staff members.
- **Execution:** `ChainService.setDepositCap` sends the transaction through the
  operator signer, either the local key (local/ci) or
  `POST /v1/deposit-cap` on the isolated signer. The change is audited as
  `chain.vault.deposit_cap_changed`.
- **At deployment:** `chain deploy --cap TUSD=100000 --cap TBTC=2`.

### Shown to users

- `GET /v1/vault/config` returns `depositCap` and `held` per token.
- The deposit panel shows the limit and refuses an amount above the remaining
  room before the wallet asks for a signature. The contract enforces it either
  way.
- Staff see and change limits in Admin → Treasury → Vault deposit limits.

## Tests

- **Foundry:**
  - the cap limits only new deposits;
  - withdrawals and escapes still work with a zero cap, and they release room;
  - direct transfers neither count nor cause an underflow;
  - a constructor length mismatch is refused;
  - the invariant `held == net deposits` holds over 4 096 random calls.
- **Coverage:** all branches and functions of the contract.
- **Anvil end-to-end:**
  - a deploy with a cap;
  - a deposit over the cap is refused;
  - a two-person change to 200, then the deposit succeeds;
  - "unlimited" removes the cap;
  - custody stays consistent.

## Consequences

- **New code for the auditors** (`docs/security/audit-readiness.md`).
- **Choosing the cap:** it bounds the loss from an unknown contract bug. It
  does not replace the audit. A suggested start is a few thousand dollars per
  token in value, raised step by step as the platform builds a track record.
- **Existing deployments:** a deployed vault cannot be changed, so earlier
  deployments have no cap. A new deployment needs `chain deploy` again (with a
  `--suffix`).
