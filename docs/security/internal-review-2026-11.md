# ExchangeVault: internal security review, November 2026

**This is an internal review by the development team. It is not an
independent audit.** It does not replace one, and nothing may describe the
contract as "audited" because of it. It was requested by the owner, who
plans an open launch before an external audit (see "Residual risk").

- Commit reviewed: the branch head before the fix commit that adds this file.
- Scope: `contracts/src/ExchangeVault.sol`, plus the backend assumptions it
  relies on (`apps/api/src/chain/chain.service.ts`).

## Method

- **Manual review:**
  - line by line;
  - each external function against the invariants in `audit-readiness.md`;
  - the freeze/escape accounting traced across all orders of calls.
- **Tests:** a regression test and a fuzz test for each finding, run against
  both the old and the fixed contract.
- **Slither 0.11.3:** 8 results. They are the same categories as already
  triaged in `audit-readiness.md` (strict equality, deposit reentrancy
  guarded by `nonReentrant`, timestamps, low-level calls, naming). No new
  issue.
- **Coverage after the fix:** 100% of branches and functions.

## Findings

### F-1 (critical, fixed): a deposit made after the last root could be paid twice after a freeze

- **Where:** `escapeDeposit`.
- **What:**
  1. A user deposits after the latest committed root.
  2. The deposit is credited, and the user withdraws it with a normal signed
     withdrawal.
  3. The vault then freezes.
  4. `escapeDeposit` pays the deposit again. `escape` cannot subtract the
     withdrawal from it, because it floored the user's committed balance at
     zero.
- **Who pays:** the difference comes out of other users' funds. The last
  users to escape cannot be paid in full.
- **Reproduction:** `test_freeze_withdrawnPostRootDepositIsNotPaidTwice`.
  - Old contract: alice is paid twice, and bob's escape reverts
    (`TransferFailed`).
- **Fix:** `escape` and `escapeDeposit` now share one netting counter per
  user and token (`escapeNetted`). The withdrawals executed against the
  frozen root (`withdrawnAt[stateIndex] + withdrawnAt[stateIndex+1]`) are
  subtracted once from the user's combined claims, in any call order:
  > total paid = committed + post-root deposits − those withdrawals (never
  > below 0).
- **Evidence:** `testFuzz_freeze_postRootClaimsAreNettedInAnyOrder`.
  - It covers random amounts, both snapshot slots and three call orders, with
    20 000 runs.
  - It fails on the old contract and passes on the fixed one.
  - It checks the exact payouts, bob's full balance and an empty vault at the
    end.

### F-2 (high, fixed in the backend): trading gains withdrawn before the next root left a freeze short

- **Where:** the backend withdrawal signing (`requestWithdrawal`,
  `treasuryWithdraw`).
- **What:** a frozen root F owes each wallet its leaf plus its deposits after
  F, minus its withdrawals against F or F + 1. Two backend paths broke this:
  - **User withdrawals:** the backend signed withdrawals up to the user's
    whole available balance. That balance includes trading gains made after
    F, which F does not contain. Those gains were still owed to the losing
    side under F. If they were withdrawn and the vault then froze, the last
    users to escape could not be paid.
  - **Fee revenue:** fees collected after F are likewise still inside users'
    leaves at F.
- **Fix (ADR-0037):** before signing, the backend checks both roots a freeze
  could leave the vault on (afterState − 1 and afterState). It never checks a
  root older than the confirmed on-chain index.
  - **User withdrawals** must fit in: leaf + deposits after F − withdrawals at
    {F, F+1}. Deposits are withdrawable at once. Trading gains become
    withdrawable once a later root includes them.
  - **Treasury withdrawals** must fit in: vault balance at the indexed block −
    open signed withdrawals − everything all wallets could claim under F.
  - **Concurrency:** both checks run under a per-wallet (or treasury)
    advisory lock, inside the signing transaction. The treasury check also
    runs at approval time.
- **Evidence:** integration test `withdrawals never exceed what a frozen root
would still owe (ADR-0037)` on Anvil, and the updated treasury test.

### Observations (no change needed now)

- **O-1, operator key.** A stolen operator key can sign withdrawals for any
  amount and drain the vault. The signer's limits do not apply to a stolen
  raw key. Mitigations:
  - the deposit cap (ADR-0033) bounds the loss;
  - before real funds, the key must live in a KMS/HSM.
- **O-2, operator liveness.** If no root is committed for `freezeDelay`
  (for example the operator runs out of gas), anyone can freeze the vault,
  and a freeze is permanent. Before real funds this needs an alert on the
  operator's gas balance and on commit lag.
- **O-3, root correctness.** The contract trusts the operator's roots. A
  wrong root, through a bug or a malicious operator, could misallocate funds
  in a freeze. Users can check their own leaf with the downloadable proof.
- **O-4, real tokens.** USDC can pause transfers and blacklist addresses. A
  pause stops all movements; a blacklisted user cannot withdraw. Neither puts
  other users' funds at risk.
- **O-5, the escape hatch is untested in production.** It has been exercised
  on Anvil only.

## Residual risk

This review found two serious problems in a contract that had already
passed 100% coverage and fuzzing, which is why reviews by other people
matter. An independent audit, or at least a public audit contest, is still
needed before significant funds. Until then:

- **Keep the contract deposit cap small.** It is the maximum loss from an
  unknown bug.
- **Never describe the contract as audited.**
