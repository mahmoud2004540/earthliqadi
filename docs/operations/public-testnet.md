# Launching the public testnet beta

This guide runs the exchange on a **public test network** with test tokens
that have no value. Real money is never involved. The decisions behind it are
in ADR-0033 (deposit cap) and ADR-0034 (public testnet).

## What you need

| Item                                | Notes                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Linux server (VPS) with Docker    | Any provider. Check its current prices yourself.                                                                                                        |
| A domain name                       | Point it at Cloudflare ([cloudflare-edge.md](cloudflare-edge.md)). Cloudflare also supplies the country headers the region block needs (ADR-0022–0024). |
| An RPC endpoint for the testnet     | Public RPCs are rate-limited. A free plan from an RPC provider is more reliable.                                                                        |
| Two new wallets, used only for this | **deployer** (pays for deployment) and **operator** (held by the signer service). Never reuse a wallet that holds real funds.                           |
| Test ETH for both wallets           | From a public faucet for the chosen network. It has no value.                                                                                           |
| An SMTP account                     | For verification e-mails (`MAIL_TRANSPORT=smtp`).                                                                                                       |

Recommended network: **Base Sepolia** (chain id 84532) or **Arbitrum
Sepolia** (421614).

## 1. Configure

```bash
cp .env.example .env
```

Set at least the following. Generate every secret fresh, for example with
`openssl rand -base64 32`, and never commit `.env`.

```bash
NODE_ENV=production
DEPLOY_ENV=staging
WEB_ORIGIN=https://your-domain.example
SESSION_COOKIE_SECURE=true
MAIL_TRANSPORT=smtp            # plus the SMTP_* settings
STAFF_MFA_REQUIRED=true
PII_ENCRYPTION_KEY=…           # 32 bytes, base64
MFA_ENCRYPTION_KEY=…           # 32 bytes, base64
CSRF_SECRET=…                  # 40+ random characters

# Region block (ADR-0022..0024): Cloudflare headers, see cloudflare-edge.md
GEO_COUNTRY_HEADER=x-edge-country
GEO_REGION_HEADER=x-edge-region
GEO_UNKNOWN_COUNTRY=deny
SANCTIONS_SYNC_HOURS=24

# Chain
CHAIN_RPC_URL=https://…        # your Base Sepolia / Arbitrum Sepolia RPC
CHAIN_CONFIRMATIONS=10         # at least 5 is enforced
SIGNER_URL=http://signer:4100
SIGNER_HMAC_SECRET=…           # 32+ random characters, same value for the signer

# Signer service (the operator key lives only here)
SIGNER_OPERATOR_KEY=0x…        # the operator wallet's key
SIGNER_RPC_URL=https://…       # same RPC
SIGNER_CHAIN_ID=84532
# SIGNER_VAULT_ADDRESS and SIGNER_LIMITS are set after step 3 (they need the deployed addresses).
```

The server refuses to start in staging if a required setting is missing or
unsafe. The error lists the setting names, never their values.

## 2. Start the services

```bash
docker compose up --build -d postgres redis migrate api web edge engine
docker compose ps        # everything healthy
```

Do not start the `chain` service. It is the local Anvil chain, and the
public testnet replaces it. The signer starts in step 3, once the vault
exists.

## 3. Deploy the vault and the test tokens

```bash
docker compose exec -e CHAIN_DEPLOYER_KEY=0x… api \
  node dist/cli/chain.js deploy --operator 0x<operator wallet address> --cap TUSD=100000 --cap TBTC=2
```

- **`--operator`** is the **address** (not the key) of the operator wallet
  whose key is in `SIGNER_OPERATOR_KEY`.
- **`--cap`** sets the launch deposit limit per token (ADR-0033). Start small,
  then raise it later in Admin → Treasury → Vault deposit limits, with two
  staff members.
- **The command prints the vault and token addresses.** Put them in `.env`,
  with amounts in token minor units (TUSD has 6 decimals, TBTC has 8):

  ```bash
  SIGNER_VAULT_ADDRESS=0x<vault>
  SIGNER_LIMITS={"0x<TUSD>":{"perTx":"10000000000","daily":"100000000000"},"0x<TBTC>":{"perTx":"100000000","daily":"1000000000"}}
  ```

  The example limits are 10 000 / 100 000 TUSD and 1 / 10 TBTC.

- **Start the signer:** `docker compose --profile signer up -d signer`.
- **Empty the deployer wallet afterwards.** It is not needed again.

## 4. First staff account

Register on the site and verify the e-mail. Then:

```bash
docker compose exec api node dist/cli/grant-role.js --email you@… --role administrator --reason "testnet launch"
```

Enable MFA when asked. A second staff member is needed for approvals: a
deposit-limit change, a treasury withdrawal or a role grant.

## 5. Check

- [ ] `https://your-domain.example/status` shows all components operational.
- [ ] Sign in with a wallet → Dashboard → Balances shows the network name and
      the deposit limit.
- [ ] **Mint test tokens**, deposit a small amount, and check that it is
      credited after the confirmations.
- [ ] Request a withdrawal, submit it from the wallet, and check that it
      completes.
- [ ] `docker compose exec api node dist/cli/chain.js custody` → all OK.
- [ ] A restricted country (via a VPN test from that location) is blocked.

## Operating

- **Reorg alert:** the audit action `chain.reorg.detected` (ADR-0034) means
  indexing has stopped. Funds are safe in the contract. Investigate before
  doing anything else.
- **Backups:** `scripts/backup.sh` (see
  [backup-recovery.md](backup-recovery.md)).
- **Monitoring:** `scripts/monitoring-up.sh` (see [runbooks.md](runbooks.md)).

## Never on the testnet

- A real token address, or any mainnet RPC. The API refuses non-test chain
  ids.
- Telling users that test tokens have value, or that they can be sent to an
  exchange.
