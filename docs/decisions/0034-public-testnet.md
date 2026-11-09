# ADR-0034: Running on a public testnet

- Status: Accepted
- Date: 2026-11-09
- Context: the owner wants a public beta with test tokens, before any audit or
  real money (ADR-0014, ADR-0033). Until now the vault had only been
  exercised on the local Anvil chain.

## Decision

### Which networks

The vault runs only on the test networks in `TEST_NETWORKS`
(`packages/shared/src/chain/networks.ts`). Each entry gives the name, a
public RPC for wallets, the explorer and where to get test gas.

- **Allowed:** Sepolia, Holesky, Base Sepolia and Arbitrum Sepolia, plus the
  local chain.
- **Not allowed:** mainnets. They are absent, so the API refuses any other
  chain id (`ALLOWED_CHAIN_IDS`).
- **Recommended:** Base Sepolia or Arbitrum Sepolia. Blocks are fast and
  test ETH is easy to get.

### Keys

- **The vault operator is always the signer service's address.** The API
  never holds a raw key outside local/ci (ADR-0015).
- **The deploy command asks the signer for that address**
  (`GET /v1/address`, authenticated with HMAC) and deploys the vault with it.
- **Deployment gas is paid by a separate deployer key,** `CHAIN_DEPLOYER_KEY`.
  Only `chain deploy` reads it, it is never part of the server
  configuration, and it can be emptied after deployment. The deploy command
  refuses to start if the deployer has no test ETH.

### Test tokens

The test tokens let anyone mint up to a per-call limit; they have no value.

- **On public testnets:** the deposit panel shows **Mint test tokens**. It
  calls `mint` from the user's own wallet, so the server sends nothing and
  holds no faucet key.
- **Gas:** users get test ETH from public faucets. The panel says which.
- **Local chain:** the server faucet is unchanged, and it stays refused
  outside local/ci.

### Confirmations and reorgs

- **Confirmation depth:** in staging and production, `CHAIN_CONFIRMATIONS`
  must be at least 5 when a chain is configured. The config refuses to start
  otherwise.
- **Reorg detection:** the indexer stores the hash of the last indexed block.
  On each pass it first checks that this block still has the same hash. If
  not, a reorg was deeper than the confirmation depth, and deposits may
  already be credited in the immutable ledger. In that case it:
  - **stops indexing** (`ChainInvariantError`);
  - records `chain.reorg.detected` once;
  - leaves the ledger untouched.

  Recovery is manual: investigate, post corrections through approvals, and
  only then move the cursor. Funds stay safe meanwhile: the escape hatch
  depends only on the contract.

### Wallets and explorers

- **Adding the network:** when the wallet does not know the network, the
  panel offers to add it with the entry's name, RPC and explorer.
- **Explorer links:** the vault address links to the explorer.

## Not done (and not claimed)

- **No hosting:** there is no hosted deployment, domain or monitoring
  destination yet. These need an account and payment, which is the owner's
  decision. `docs/operations/public-testnet.md` has the steps.
- **No HSM:** the signer key is still a software key (HSM/KMS before real
  funds).
- **No automatic reorg recovery:** recovery is a manual procedure.
- **No index reorgs:** price indices from on-chain oracles are not checked
  for reorgs. They are re-read on every sample.
