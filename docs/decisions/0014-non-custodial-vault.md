# ADR-0014: Non-custodial vault (testnet), deposits, withdrawals and the escape hatch

- Status: Accepted
- Date: 2026-11-03
- Phase: 8
- Context: ADR-0013 (wallet sign-in, no KYC: the platform must not hold user funds)

## Decision

### Contract: `contracts/src/ExchangeVault.sol` (Solidity 0.8.28, Foundry)

Testnet and local chain only. **Not audited.**

- **Deposits:** `deposit(token, amount)` for allow-listed ERC-20s (set at
  construction). The vault credits what it actually received (fee-on-transfer
  safe). Each deposit gets a sequential id and a record.
- **Withdrawals:** the operator signs an EIP-712
  `Withdrawal{id, user, token, amount, afterState, expiry}` after holding the
  amount in the ledger.
  - Anyone may submit it, but funds always go to `user`.
  - Each id can be used once, signatures with a high `s` value are refused,
    and the signature expires.
  - The operator **cannot move funds any other way**.
- **State commitments:** `commitState(index, root, lastDepositId)` (operator
  only, sequential). The root is a Merkle tree of
  `(wallet, token, balance)` leaves: double-hashed leaves, sorted pairs.
- **Escape hatch:** if no commitment arrives for `freezeDelay` seconds, anyone
  can call `freeze()`. Users then:
  - `escape(token, balance, proof)` once: committed balance minus withdrawals
    signed against the latest or next snapshot (`withdrawnAt[stateIndex]` +
    `withdrawnAt[stateIndex+1]`);
  - `escapeDeposit(id)` for their deposits made after the snapshot.
- **No admin keys:** no upgradeability and no owner functions besides the
  immutable operator's commit/sign role.

Why `afterState ≤ stateIndex + 1` and the two-slot subtraction: the backend
snapshots under an exclusive DB lock, and withdrawal holds take a shared lock
and record the latest snapshot index. A withdrawal held after snapshot S+1
carries S+1 even before S+1 is on-chain. So whatever root is current at
freeze time, the funds of every signed withdrawal are counted exactly once
(test: `test_escape_…`, fuzz and the live-chain integration test).

### Backend: `apps/api/src/chain`

- **Ledger:**
  - `VAULT_CUSTODY` (system, debit-normal) mirrors the vault.
  - `USER_WITHDRAWING` holds signed, unexecuted withdrawals.
  - Entries: `CHAIN_DEPOSIT`, `WITHDRAWAL_HOLD`, `WITHDRAWAL_FINAL`,
    `WITHDRAWAL_RELEASE`.
  - Assets link immutably to a token (`assets.chain_token_address`, real
    assets only). Simulated deposits are refused for them (trigger).
- **Indexer:** reads `Deposited` and `Withdrawn` logs up to
  `head − CHAIN_CONFIRMATIONS` and applies each idempotently. Keys are
  `chain-deposit:<chain>:<vault>:<id>`, unique `(chain, tx, logIndex)` and
  withdrawal ids. Each block range is one transaction with the cursor.
  - An executed withdrawal we never signed, or one that does not match the
    ledger, raises `ChainInvariantError`; the indexer halts and alerts.
  - Deposits from unknown wallets create the wallet account.
- **Withdrawal expiry** uses chain time. A hold is released only after the
  indexed chain time passes the expiry, when the contract can no longer
  execute it.
- **State committer:**
  - Snapshot under a DB lock in REPEATABLE READ: per wallet, per vault
    token, available + locked + margin. Leaves are stored (append-only).
  - Then the root is committed on-chain; retried until mined.
  - Users download their proof (`GET /v1/vault/proof`).
- **Custody reconciliation:** `VAULT_CUSTODY` must equal the vault's on-chain
  token balance at the indexed block (CLI `chain custody`, admin
  `GET /v1/admin/vault/custody`).
- **Vault-backed markets** accept only wallet accounts, so every vault-backed
  balance is claimable on-chain.
- **Chains:** mainnet chain ids are refused in code. A raw `CHAIN_OPERATOR_KEY`
  is refused outside local/ci (a signing service with HSM/KMS is required).
  The local faucet (`anvil_setBalance` + `mint`) is local-only.

### Tooling

- Foundry runs from the pinned official image (`contracts/forge.sh`, CI job
  `contracts`). The tests use a self-written cheatcode interface, with no
  vendored libraries. The suite includes unit, fuzz (1000 runs) and an
  invariant test (vault balance = Σ deposits − Σ withdrawals).
- A local Anvil chain runs in Compose (`chain`, state persisted). The API
  integration suite runs against it (required in CI).

## Consequences

- Users can always exit, with or without the operator, as long as they keep
  (or can fetch) their latest proof.
- The operator remains trusted for **liveness** (signing withdrawals,
  committing roots) and for **correct roots**. A malicious root could still
  understate a balance; mitigations come with validity proofs or
  multi-party attestations (Phase 9+ research item).
- Before any real asset:
  - an external security audit of the contract;
  - a signing service (HSM/KMS, separate host, rate limits);
  - multisig + timelock policy for future versions;
  - deeper confirmation and reorg handling for public chains;
  - monitoring of the operator key;
  - legal review (ADR-0013).
