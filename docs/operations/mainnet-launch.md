# Launching with real funds (Base, USDC)

This turns on real funds (ADR-0038). **The vault contract has not been
independently audited.** The internal review is not an audit
(`docs/security/internal-review-2026-11.md`). The on-chain deposit cap is the
maximum anyone can lose to an unknown contract bug.

Owner decisions on record:

- open launch;
- counsel approved (stated by the owner, 2026-11-10);
- **initial cap 100 000 USDC;**
- alerts by e-mail.

## Before you start (blocking)

- [ ] **The signer key is in a KMS/HSM,** not a software key. _Pending: needs
      the AWS account._
- [ ] **Legal pages from counsel** are published: terms, privacy policy (name
      Privy if email wallets are on) and the legal entity.
- [ ] **Hosting:** production hosting, a paid Base RPC provider, and backups
      (`backup-recovery.md`).
- [ ] **New wallets:**
  - a **deployer** with a little ETH on Base (it can be emptied after the
    deploy);
  - an **operator** (in the signer) with ETH on Base for commits.

## 1. Configure `.env`

```bash
NODE_ENV=production
DEPLOY_ENV=production
CHAIN_MAINNET=true
CHAIN_RPC_URL=https://…            # paid Base mainnet RPC (not mainnet.base.org)
CHAIN_CONFIRMATIONS=20             # at least 20 is enforced
NEXT_PUBLIC_REAL_FUNDS=true        # real-funds wording on the site (rebuild web)
SIGNER_URL=http://signer:4100
SIGNER_HMAC_SECRET=…
SIGNER_RPC_URL=https://…           # same RPC
SIGNER_CHAIN_ID=8453
MAIL_TRANSPORT=smtp                # plus SMTP_HOST, SMTP_USER, SMTP_PASSWORD, MAIL_FROM
ALERT_EMAIL_TO=you@…
METRICS_TOKEN=…                    # 32+ random characters
```

Everything else is as in `public-testnet.md` step 1 (secrets, region block,
Cloudflare). The API refuses to start if a rule is broken, and names the
setting.

## 2. Deploy the vault with the 100 000 USDC cap

```bash
docker compose exec -e CHAIN_DEPLOYER_KEY=0x… api \
  node dist/cli/chain.js deploy --operator 0x<operator address> --cap USDC=100000
```

- **It uses only Base's USDC,** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
  and checks the token's symbol and decimals first.
- **It refuses to run** without a cap, with test tokens, or while an earlier
  vault still holds USDC.
- **Signer:** put the printed vault address in `SIGNER_VAULT_ADDRESS`. Set
  `SIGNER_LIMITS` for USDC in minor units (6 decimals), for example
  `{"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913":{"perTx":"10000000000","daily":"100000000000"}}`,
  which is 10 000 per withdrawal and 100 000 per day. Then start the signer.
- **Changing the cap later** goes through Admin → Treasury → Vault deposit
  limits, with two staff members. "Unlimited" is refused.

## 3. Markets

The deploy creates no markets. Add perpetuals in USDC through the admin API.
For each oracle feed:

1. Copy the address from Chainlink's **official** documentation for Base
   mainnet.
2. Check it on-chain: `description()` (for example "BTC / USD"),
   `decimals()`, and a recent `latestRoundData` timestamp.
3. Have a second staff member verify it before the market opens.

## 4. Monitoring and alert e-mails

```bash
scripts/monitoring-up.sh      # e-mails alerts to ALERT_EMAIL_TO
```

- **The alert group `exchange-vault`** covers:
  - a frozen vault;
  - late commits;
  - the freeze window at risk;
  - a failed vault read;
  - low or critical operator gas;
  - indexer lag.
- **Send yourself a test alert once**, and check that it arrives (and is not
  in spam).

## 5. Final checks

- [ ] `/status` shows all components operational.
- [ ] The site banner says "Beta with real funds…", not "testnet".
- [ ] Deposit a small amount from your own wallet, then trade, withdraw, and
      check `chain custody` → OK.
- [ ] A blocked country is refused (VPN test).
- [ ] Empty the deployer wallet.
