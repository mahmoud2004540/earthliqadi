# ADR-0035: Email wallets through Privy

- Status: Accepted (owner decision, 2026-11-10)
- Context: sign-in needs a browser wallet (ADR-0013). Many people have none,
  and they cannot send tokens from an exchange to the platform without one.
  Hyperliquid solves this with email wallets from an external provider. The
  owner chose Privy.

## Decision

### What the user sees

- `/connect` keeps **Connect wallet** (browser extension) and adds **No
  wallet? Continue with email** when Privy is configured.
- The email option opens Privy's e-mail sign-in. Privy creates an Ethereum
  wallet for users who have none (`createOnLogin: users-without-wallets`).
- **Sign-in is unchanged:** the wallet signs the same Sign-In with Ethereum
  message as an extension wallet. Privy shows the message and asks the user to
  confirm. The API is untouched, and the account is the wallet address.
- **Dashboard → Balances → Your email wallet:** the address, a copy button and
  **Export private key** (Privy's export window). The user can then receive
  tokens at that address, deposit with the normal Deposit button, and take
  the key to any wallet.
- **Sign-out** also ends the Privy session in that browser.

### What the exchange gets, and what it does not

- **It gets only the wallet address.** The e-mail address stays with Privy.
  There is still no KYC (ADR-0013).
- **It never gets the key.** Per Privy's documentation, keys are sharded,
  used inside trusted execution environments and assembled for export only in
  an isolated Privy frame. This is Privy's claim. The exchange has not
  verified or audited it, and the site says "Privy states".
- **No Privy app secret.** The exchange uses only the public app id
  (`NEXT_PUBLIC_PRIVY_APP_ID`). It never calls Privy's server API, so a
  compromised server cannot touch email wallets through Privy.

### How it is built

- **Optional.** Without `NEXT_PUBLIC_PRIVY_APP_ID`, nothing changes and the
  Privy code is not downloaded (`next/dynamic`). The id is validated in
  `webEnvSchema` and baked in at web build time.
- **Only where needed.** The provider wraps `/connect` and `/dashboard` only.
- **Networks:** the email wallet may use exactly the allowed test networks
  (`TEST_NETWORKS`, ADR-0034); mainnets are absent. Before each transaction
  it is switched to the vault's network.
- **One signer per account.** `lib/wallet.ts` returns the email wallet only
  when its address equals the signed-in account. Otherwise it returns the
  extension wallet, and the existing wrong-account check applies. This covers
  vault deposits, withdrawals, test-token minting and API-key authorisation.
- **CSP:** when enabled, the policy adds the hosts from Privy's CSP guide
  (`auth.privy.io` frames and connections, WalletConnect relays,
  `*.rpc.privy.systems`, the Cloudflare captcha) and the https RPCs of the
  test networks. `frame-ancestors`, `object-src`, `base-uri` and
  `form-action` stay locked. Privy says to re-check the CSP after every SDK
  upgrade.
- **Dependencies:** `@privy-io/react-auth` is pinned exactly. Its Solana peer
  dependencies are pinned to versions that work together, because the
  auto-installed ones broke the build. Solana is not used.

## Tests

- **Unit:**
  - the CSP with Privy off and on;
  - provider selection (email wallet only for its own address, after
    switching network; otherwise the extension);
  - the email-wallet networks equal `TEST_NETWORKS`;
  - the app-id validation.
- **Build:** with and without an app id. Without one, `/connect` and
  `/dashboard` stay at their usual size.
- **Browser smoke test** with a placeholder id: the email button renders, the
  CSP header is correct, and an invalid id gives a clear error instead of a
  broken page.

## Not done (and not claimed)

- **No test against a real Privy app:** that needs the owner's account. The
  checklist is in `docs/operations/public-testnet.md` (step 4b).
- **Privy's own security:** availability and key handling are Privy's
  responsibility. If Privy is unavailable, email users cannot sign until it
  returns. Their vault funds stay safe and the escape hatch works with an
  exported key.
- **Legal:** Privy processes users' e-mail addresses. The privacy policy and
  the lawyer review must name Privy as a processor before launch.
- **No unilateral-export block:** Privy lets users export with their own
  session even outside our UI. That is intended here: it is the user's wallet.
