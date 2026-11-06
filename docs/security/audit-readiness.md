# ExchangeVault: audit readiness

This is the brief for an external smart-contract audit. **The contract has
not been audited.** Nothing in this repository claims otherwise. Until an
audit report is published and its findings are fixed, the contract is for
test networks only.

## Scope

| Item            | Value                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| In scope        | `contracts/src/ExchangeVault.sol` (one contract, about 280 lines)                                                       |
| Out of scope    | `TestToken.sol` and `TestPriceFeed.sol` (test fixtures); the off-chain backend, apart from the assumptions listed below |
| Compiler        | solc 0.8.28, optimizer 10 000 runs, EVM `cancun`                                                                        |
| Dependencies    | none (no imports, no libraries, no proxies)                                                                             |
| Commit          | to be frozen when the audit is booked; the deployed bytecode must match it                                              |
| Design document | `docs/decisions/0014-non-custodial-vault.md` (ADR-0014)                                                                 |

## What the contract does

ExchangeVault is a non-custodial collateral vault for an off-chain matching
engine.

1. **Deposit.** A user deposits an allow-listed ERC-20 token. The vault
   credits the amount it actually received.
2. **Withdraw.** The operator signs an EIP-712 `Withdrawal`. Anyone may
   submit it, and the funds always go to `user`. Each id works once, the
   signature expires, and high-`s` signatures are refused.
3. **Commit state.** At regular intervals the operator commits a Merkle root
   of every user's balance per token. The commit also records the last
   deposit id the root includes.
4. **Escape hatch.** After `freezeDelay` seconds without a commit, anyone
   can `freeze()`. After that, each user can:
   - `escape()` the committed balance, with a Merkle proof, minus the
     withdrawals signed against the current or the next snapshot;
   - `escapeDeposit()` each deposit made after the last root.

The contract has no owner, no upgrade path and no pause. The operator can
only commit roots and sign withdrawals.

## Actors and trust

| Actor    | Can                                                       | Cannot                                                         |
| -------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| User     | deposit, submit signed withdrawals, escape after a freeze | withdraw without an operator signature before a freeze         |
| Operator | sign withdrawals, commit roots                            | move funds any other way, stop the escape hatch, change config |
| Anyone   | relay withdrawals, call `freeze()` once allowed           | redirect funds                                                 |

**Trusted for correctness:** the operator is trusted to commit correct
roots. A wrong root could understate or overstate balances, and the escape
hatch pays whatever the latest root says. Users can keep their latest proof
(`GET /v1/vault/proof`).

## Invariants we expect to hold

1. Funds leave the vault only through:
   - `withdraw` (operator signature, to `user`);
   - `escape` (after a freeze, at most the committed balance);
   - `escapeDeposit` (after a freeze, the depositor's own late deposit).
2. A signed withdrawal can run at most once. It cannot run after its expiry,
   after a freeze, or more than one snapshot ahead (`afterState ≤ stateIndex + 1`).
3. After a freeze:
   - `escape` pays each (user, token) at most once;
   - `escapeDeposit` pays each deposit at most once, only for deposits after
     the root, and only to the depositor.
4. **Signed withdrawals are counted once.** The funds of every executed
   signed withdrawal are counted exactly once across the root and the
   escape. The two-slot subtraction is explained in ADR-0014.
5. **Freezing.** The vault cannot be frozen while the operator commits in
   time, and once frozen it stays frozen.
6. **Reentrancy.** No external call can re-enter a state-changing function
   (`nonReentrant`).

## Tooling results (before the audit)

**Foundry tests: 21 passing.**

- Unit tests;
- fuzz tests (1 000 runs each);
- an invariant test: the vault holds exactly net deposits (64 × 64 calls);
- edge-case tests in `test/ExchangeVaultEdges.t.sol` for every revert
  branch:
  - re-entrancy through a malicious token;
  - fee-on-transfer tokens;
  - tokens that return `false`;
  - malformed signatures;
  - freeze rules.

**Coverage:** 100% of lines, statements, branches and functions of
`ExchangeVault.sol` (`./forge.sh coverage`).

**Slither 0.11.** 9 findings, triaged:

| Detector                                          | Verdict                                                                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| reentrancy-balance, reentrancy-benign (`deposit`) | False positive: `nonReentrant`; re-entry is tested and refused                                                                            |
| incorrect-equality (`received == 0`)              | Intended: a token that delivers nothing must not create a deposit                                                                         |
| missing-zero-check (constructor)                  | **Fixed:** the constructor now refuses a zero operator, a freeze delay under 1 hour, an empty token list and token addresses without code |
| timestamp                                         | Intended: expiry and freeze delay are hour-scale, so miner drift is irrelevant                                                            |
| low-level-calls                                   | Intended: safe ERC-20 calls that accept tokens returning no value                                                                         |
| naming-convention                                 | Style only                                                                                                                                |

## Known limitations and questions for the auditors

1. **A withdrawal signed but never submitted can be stranded by a freeze.**
   This is shown in the test
   `test_limitation_unsubmittedWithdrawalAtFreezeIsStranded`.
   1. The operator holds an amount after snapshot S and signs it.
   2. Root S+1 then excludes that amount.
   3. If the user never submits the withdrawal, and the vault freezes while
      root S+1 is current, then `withdraw` is closed and `escape` pays only
      the root balance. The amount stays in the vault.

   **Today's mitigation:** the expiry (1 hour by default) is far shorter than
   the freeze delay (7 days in deployment). Before expiry the user can still
   submit the withdrawal, since the vault is not frozen yet. After expiry the
   backend releases the hold, but that release reaches the chain only in the
   next root.

   **The gap:** if the operator stops between the expiry and the next
   commit, the amount is stranded.

   **We ask the auditors to review a fix.** One option is to let a frozen
   vault pay unexecuted, unexpired-at-freeze withdrawals whose `afterState`
   is older than the frozen root.

2. **Token assumptions.** Allow-listed tokens must be plain ERC-20s:
   - no rebasing;
   - no balance changes outside transfers.

   Fee-on-transfer tokens are handled. **Tokens with an admin blacklist**
   (for example USDC and USDT) can freeze the vault's own balance. That is
   outside the contract's control and is a listing decision.

3. **Operator key.** In production the key must live in an HSM/KMS behind
   the signing service (ADR-0015). A leaked key can sign withdrawals for any
   amount up to the vault balance. The backend's per-withdrawal limits do
   not bind the contract.
4. **No upgrade path.** A bug fix means deploying a new vault and asking
   users to move their funds. This is deliberate: there is no admin key that
   could be abused.
5. **Merkle tree.** Leaves are double-hashed and pairs are sorted. Please
   confirm there is no leaf/node confusion and no proof malleability that
   matters here.

## How to run

```
cd contracts
./forge.sh test            # 21 tests incl. fuzz and invariant
./forge.sh coverage        # 100% on ExchangeVault.sol
./forge.sh fmt --check
# Slither (solc 0.8.28): run on a copy of src/ExchangeVault.sol outside the Foundry project
slither ExchangeVault.sol --solc-args "--optimize --evm-version cancun"
```

The API's integration tests deploy the vault on a local Anvil chain. They
exercise deposits, signed withdrawals, root commits and the escape hatch end
to end (`apps/api/test/vault.e2e-spec.ts`, `signer.e2e-spec.ts`).
