# ADR-0038: Real-funds mode (Base mainnet, USDC only)

- Status: Accepted (owner decision, 2026-11-10: open launch before an
  external audit)
- **Legal:** the owner stated on 2026-11-10 that counsel approves the launch.
  The written approval is held by the owner; the code cannot verify it.
- **Context:** until now the vault ran only on test networks. The owner chose
  an open launch with real funds, after an internal review
  (`docs/security/internal-review-2026-11.md`, which is not an audit) and its
  fixes (ADR-0037).

## Decision

Real funds are opt-in. Two build/run switches stay off until the launch
checklist below is done.

### API: `CHAIN_MAINNET=true`

- **Production only.** Config validation refuses it in any other
  `DEPLOY_ENV`.
- **Requirements:** `CHAIN_RPC_URL`, and `CHAIN_CONFIRMATIONS ≥ 20`.
- **Networks:** only chains in `MAINNET_NETWORKS` are accepted; test networks
  are then refused. Today that is **Base (8453)**.
  - Its USDC address, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, was
    checked against Circle's official page.
  - It was also checked on-chain: "USD Coin", USDC, 6 decimals.
- **Collateral:** only that network's USDC.
  - `chain deploy` refuses test tokens and any other token.
  - It reads the token's own symbol and decimals before deploying.
- **Deposit cap:** a finite cap is required at deployment
  (`--cap USDC=5000`). It cannot be set to "unlimited" later.
- **Redeploying:** refused while the ledger still holds the asset for an
  earlier vault, or if the token is already linked to another asset code.
- **Signer:** the signer service is required, as in every public
  environment. The deploy needs `CHAIN_DEPLOYER_KEY` and `--operator`
  (the signer's address).
- **No markets are created by the deploy.** Perpetuals are added through the
  admin API with oracle index sources, either Chainlink-compatible
  `AggregatorV3` feeds or the spot mid. Staff must check every feed address
  against Chainlink's official documentation. The code never contains feed
  addresses.
- **What changes for users:**
  - `GET /v1/vault/config` reports `testnet: false` and the Base network;
  - test-token minting and the faucet are off;
  - ledger descriptions drop "(testnet)".

### Web: `NEXT_PUBLIC_REAL_FUNDS=true` (build time)

- **Wording:** `src/i18n/real-funds.ts` replaces each testnet sentence with a
  real-funds one: an unaudited-contract warning, the deposit cap, and "only
  deposit what you can afford to lose".
- **Tests:**
  - every replaced sentence still exists;
  - no testnet or "no real funds" sentence is left;
  - nothing claims an audit, a licence or insurance;
  - "not been independently audited" is present.

## Launch checklist (must be done before the switches are turned on)

1. **Signer key in a KMS/HSM**, not a software key (audit-readiness O-1).
   _Not done: needs the owner's AWS account._
2. **Alerts (done; delivery still needs a destination):** the alert group
   `exchange-vault` covers a frozen vault, a late commit, 10% of the freeze
   window used, a failed vault read, low or critical operator gas, and
   indexer lag. A missed commit window lets anyone freeze the vault for
   good. The gauges are `exchange_vault_*` and
   `exchange_chain_indexer_lag_blocks`, and the runbook sections are in
   `runbooks.md`. Alertmanager needs a real receiver (e-mail, phone) set up
   by the owner.
3. **Legal pages:** the terms, the privacy policy (naming Privy if email
   wallets are on) and the legal entity, provided by counsel. The site
   currently says these are unpublished.
4. **Hosting:** production hosting with backups and monitoring
   (`docs/operations/*`), and a paid RPC provider. Base's public RPC is
   rate-limited and not for production.
5. **A small initial cap,** raised step by step through maker-checker.
6. **A redeploy** of the vault from the reviewed commit, with
   `chain custody` OK afterwards.

## Tests

- **Config:** production-only, 20+ confirmations, RPC required.
- **Base mainnet fork** (`test/mainnet-fork.e2e-spec.ts`, against
  `anvil --fork-url https://mainnet.base.org`, with the real USDC contract
  and no real funds):
  - the deploy refusals;
  - a deploy with a 1 000 USDC cap;
  - the public config;
  - "unlimited" refused;
  - a deposit, then a deposit over the cap refused;
  - indexing and a signed withdrawal paid in USDC;
  - custody OK;
  - a redeploy refused while funds are held;
  - the run drains itself, so it can be repeated.
- **Web:** the real-funds wording tests.
