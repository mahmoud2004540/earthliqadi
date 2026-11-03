# ADR-0013: Wallet sign-in without KYC, and a non-custodial direction

- Status: Accepted (product decision by the owner, 2026-11-03)
- Phase: between 7 and 8
- Supersedes: the customer-facing parts of ADR-0012's identity verification

## Context

The owner wants the platform to work like Hyperliquid:

- customers connect a wallet and sign;
- there is no registration;
- there is no identity verification.

Hyperliquid can operate this way because it is **non-custodial**: user funds
sit in an on-chain bridge/contract, not in an operator's custody, and it
blocks some jurisdictions. A **custodial** exchange that accepts real money
without KYC breaches anti-money-laundering law in most jurisdictions.

## Decision

1. **Customers sign in with Sign-In with Ethereum (EIP-4361).**
   - `GET /v1/auth/wallet/nonce` issues a single-use nonce (Redis, 5 minutes).
   - `POST /v1/auth/wallet/login` verifies the message and signature:
     - domain and URI are bound to `WEB_ORIGIN`;
     - Issued At must be within 10 minutes; Expiration Time is honoured;
     - EIP-191 hash, secp256k1 recovery with the audited `@noble` libraries,
       high-s signatures rejected, EIP-55 checksums enforced.
   - Then it consumes the nonce and creates the account on first sign-in
     (no email, no password).
   - Accounts are keyed by the lower-case address. The address is immutable
     (trigger); `users_credential_chk` requires email+password or a wallet.
   - Sessions, CSRF, rate limits, audit and suspension work as for every
     account.
2. **No identity verification.** The KYC module is **off by default**
   (`KYC_ENABLED=false`): every endpoint answers 404 and the dashboard has no
   verification tab. The code stays available, disabled, for an operator who
   must enable it in some jurisdiction. `KYC_REQUIRED_FOR_REAL_TRADING` is
   no longer forced, and requires `KYC_ENABLED`.
3. **Staff keep email + password + TOTP MFA** (ADR-0012 unchanged).
   - Wallet accounts cannot set a password or an authenticator, so they
     cannot hold staff permissions when `STAFF_MFA_REQUIRED` is on.
   - `/login` is now the staff sign-in. Email registration remains for staff
     onboarding and tests.
4. **Phase 8 changes direction: non-custodial.** Instead of exchange-held
   hot and cold wallets, real-asset balances will be backed by an **on-chain
   vault contract** (testnet first):
   - deposits into the contract are credited by an indexer;
   - withdrawals are user-signed requests, settled by the contract;
   - an **escape hatch** lets users withdraw without the operator if it stops
     processing (state-root / forced-withdrawal design to be specified in
     the Phase 8 ADR).
   - The off-chain matching engine, ledger and risk engine remain; the ledger
     becomes a mirror of on-chain collateral that is reconciled against the
     contract.

## Consequences

- No account creation, email or documents for customers; one signature to
  start (paper trading today).
- **Legal/regulatory risk moves to the operator.** Non-custodial design
  reduces, but does not remove, obligations; derivatives in particular are
  regulated in many countries (the US, the EU under MiCA/MiFID, and others).
  Before real funds:
  - specialist legal advice per target jurisdiction;
  - geo-restriction (for example US persons, sanctioned countries) through a
    trusted GeoIP signal at the edge plus terms of use;
  - sanctions screening of wallet addresses (on-chain analytics provider)
    instead of identity KYC.

  These are Phase 9 items and are listed in known issues.

- Until the vault exists, nothing real is at stake: the platform remains
  paper/simulated only.
- Wallet sessions are only as safe as the user's wallet. There is no account
  recovery: whoever controls the key controls the account.
