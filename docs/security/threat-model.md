# Security controls and threat model (Phases 1–5)

Scope: identity, sessions, access control, the HTTP surface and the ledger.
Withdrawal fraud and market manipulation are modelled with the phases that
introduce withdrawals (8) and trading (3–6).

## Implemented controls

| Threat                             | Control                                                                                                                         | Verified by              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Password database leak             | Argon2id (OWASP minimum m=19 MiB, t=2, p=1; configurable upward only), transparent rehash on login                              | e2e: hash format         |
| Credential stuffing / brute force  | Per-IP auth rate limit (Redis, shared across instances); account lock after N failures                                          | e2e: 429, lockout        |
| Account enumeration                | Identical responses for register / forgot / resend / login; timing equalised by dummy hash                                      | e2e                      |
| Session theft via XSS              | `httpOnly` cookies, strict CSP on the API, CSP on web, no tokens in `localStorage`                                              | e2e: cookie flags        |
| Session fixation                   | New random token minted on every login                                                                                          | design                   |
| Stolen DB snapshot → live sessions | Only SHA-256 of session/verification tokens stored                                                                              | e2e                      |
| CSRF                               | Signed double-submit token + `Origin` check + `SameSite`; CORS disabled                                                         | unit + e2e               |
| Token leakage via URLs/Referer     | Email links carry tokens in the URL **fragment**; `Referrer-Policy: no-referrer`; fragment stripped after use                   | design + UI test         |
| Replay of email/reset tokens       | Single-use via conditional update; reset invalidates prior tokens; expiry 24 h / 1 h                                            | e2e                      |
| TOTP brute force / replay          | ±1 step window, last-used step stored and enforced atomically; challenge limited to 5 tries and single use                      | unit (RFC vectors) + e2e |
| TOTP secret disclosure             | AES-256-GCM, owner-bound AAD, never returned after enrolment                                                                    | unit + e2e               |
| Privilege escalation               | Deny-by-default auth; explicit permissions; no wildcard/superuser; self-grant refused; denials audited                          | unit + e2e               |
| IDOR on sessions                   | All `/me` queries scoped by authenticated user id                                                                               | e2e                      |
| Hidden admin / backdoor            | No seeded accounts; first staff role only via audited CLI requiring shell access                                                | review                   |
| Audit tampering                    | DB triggers block UPDATE/DELETE/TRUNCATE on `audit_logs`                                                                        | e2e                      |
| Secrets in logs                    | pino redaction of cookies, auth and CSRF headers; audit metadata scrubbed of sensitive keys                                     | unit                     |
| Stack-trace / internals disclosure | Global exception filter + body-parser error handler; generic 500s                                                               | unit + e2e               |
| Client IP spoofing (XFF)           | Edge proxy overwrites XFF; API trusts exactly one hop and is not exposed ([ADR-0004](../decisions/0004-edge-proxy-topology.md)) | manual e2e (compose)     |
| Unsafe production configuration    | Boot-time env validation rejects placeholders, insecure cookies, http origins and dev mail in staging/prod                      | unit                     |
| Vulnerable dependencies            | Pinned versions, overrides with advisories, CI `pnpm audit --audit-level high`, Dependabot, CodeQL                              | CI                       |
| Container breakout impact          | Non-root users, read-only root FS, `cap_drop: ALL`, `no-new-privileges`, loopback-only published ports                          | compose                  |

## Ledger controls (Phase 2)

| Threat                                   | Control                                                                                                  | Verified by                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Rounding / precision loss                | Integer minor units (`bigint`, `NUMERIC(38,0)`); parsing rejects excess decimals instead of rounding     | property tests               |
| Unbalanced postings (money created/lost) | Per-asset balance check in the service **and** a deferred DB constraint trigger at commit                | unit + e2e (raw SQL)         |
| Overdraft / negative balances            | Row locks + pre-check, plus DB `CHECK (allow_negative OR balance >= 0)`                                  | e2e: 30 concurrent holds     |
| Double posting (retries, races)          | Unique idempotency key + request fingerprint; concurrent duplicates resolve to one entry                 | e2e: 25 concurrent requests  |
| Deadlocks under load                     | Accounts locked in id order by every writer                                                              | e2e: 40 mixed concurrent ops |
| Rewriting history                        | Journal, postings and reconciliation runs immutable (triggers); corrections only by linked reversal      | e2e                          |
| Direct balance manipulation (SQL)        | Guard trigger: balances change only through postings; accounts cannot be deleted                         | e2e                          |
| Undetected drift or tampering            | Reconciliation recomputes everything from postings in a consistent snapshot; mismatches logged + audited | e2e: tamper detection        |
| Minting funds outside development        | Simulated deposits refused unless `DEPLOY_ENV` is `local`/`ci`; no HTTP endpoint for postings            | e2e                          |
| Asset redefinition                       | Asset code and scale immutable (trigger)                                                                 | e2e                          |

## Trading controls (Phase 3)

| Threat                                      | Control                                                                                                                    | Verified by        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Unfunded orders                             | Hold and engine command written in one transaction; insufficient funds → nothing enqueued                                  | e2e                |
| Lost or reordered commands                  | Per-market counter row lock gives gap-free, commit-ordered sequences; DB trigger checks seq = counter; engine refuses gaps | e2e + engine tests |
| Double settlement                           | Idempotency key per fill/release; settlement offset in the same transaction; contiguity check                              | e2e                |
| Silent engine divergence / tampered offsets | SHA-256 chain over commands and events; startup replay must reproduce the stored hash or the engine refuses to start       | e2e (tamper)       |
| Two engines processing at once              | Session advisory lock (standby); optimistic offset update                                                                  | design             |
| Self-trading / wash trades by one account   | Self-trade prevention (taker cancelled); settlement rejects buyer = seller; DB CHECK on trades                             | engine + e2e       |
| Settling more than was held                 | Per-order `locked_remaining` tracked; trade above buyer limit or overdraw of the hold halts settlement                     | e2e                |
| Inconsistent order states                   | Explicit state machine; illegal transitions halt settlement                                                                | unit               |
| Trading during incidents                    | Market halt (new orders blocked, cancels allowed), audited                                                                 | e2e                |
| Rewriting trading history                   | Command/event logs and trades immutable; market units immutable                                                            | e2e                |

## Market data and WebSocket controls (Phase 4)

| Threat                                           | Control                                                                                                                             | Verified by |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Misleading data (phantom liquidity, fake volume) | Book, trades, candles and ticker derived only from settled orders/trades; nothing synthetic                                         | e2e         |
| Silent staleness                                 | `delayed`/`halted` status pushed even without new events; terminal warning banners                                                  | e2e         |
| Cross-site WebSocket hijacking                   | `Origin` must equal `WEB_ORIGIN` at the handshake                                                                                   | e2e         |
| Private data leakage                             | Orders channel requires a session; only the user's own orders; revoked sessions disconnected (≤ 30 s)                               | e2e         |
| Resource exhaustion                              | Per-IP connection cap, subscription cap, message rate limit, 4 KB frames, heartbeat termination                                     | e2e         |
| Client IP spoofing on WebSockets                 | Same trusted-hop model as HTTP; the edge repeats `X-Forwarded-For` in the WS location (nginx header inheritance pitfall documented) | review      |
| Float rounding in the UI                         | Totals and spreads computed with `bigint`; only the chart plots floats (visual only)                                                | unit + e2e  |

## Paper trading and simulation controls (Phase 5)

| Threat                                          | Control                                                                                              | Verified by |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------- |
| Simulated value leaking into real balances      | Deferred trigger rejects any entry mixing paper and real assets; markets cannot mix; immutable flags | e2e         |
| Faucet abuse / double grants                    | Once per user/asset/UTC day via idempotency key (race-safe); audited                                 | e2e         |
| Bypassed triggers (privileged DB access)        | Reconciliation `MIXED_NAMESPACE_ENTRY` finding                                                       | e2e         |
| Order spam / resource exhaustion by one account | Per-user order rate limit (Redis), open-order cap per market                                         | e2e         |
| Non-deterministic or regressed engine releases  | `engine-replay` gate against recorded history before deployment                                      | Rust + e2e  |

## Perpetual futures controls (Phase 6, paper only)

| Threat                                               | Control                                                                                                                    | Verified by        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Real-money derivatives offered without authorisation | `markets_perp_paper_only_chk`; derivative account types refused for real assets (trigger)                                  | e2e                |
| Losses beyond margin / negative balances             | Closing orders capped at the bankruptcy price; liquidation orders protected at it; non-negative margin CHECK               | property + e2e     |
| Mark-price manipulation through a thin book          | Mark = index + clamped basis EMA (`maxBasisBps`); last trade never used; index median with outlier and staleness checks    | unit + e2e         |
| Stale or missing prices                              | No fresh mark: funding, liquidation and risk-increasing orders pause; UI warning                                           | e2e                |
| PnL or funding created out of nothing                | Clearing identity (Σ entry = clearing), margin, open-interest and funding-pool reconciliation; zero-sum funding allocation | property + e2e     |
| Double funding / double liquidation (multi-instance) | Funding idempotency key + state row lock; position row lock; one in-flight liquidation order per position                  | e2e                |
| Over-leverage                                        | Validated tiers (maintenance < initial margin); tier/leverage check on projected size; leverage fixed while exposed        | unit + e2e         |
| Insurance fund drained silently                      | Ledger refuses a negative fund; settlement halts that market for investigation; fund balance is public                     | ledger constraints |

## Back-office controls (Phase 7)

| Threat                                          | Control                                                                                                    | Verified by |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------- |
| Stolen staff password                           | Staff permissions require account MFA (`MFA_REQUIRED`); cannot be disabled outside local/ci                | unit + e2e  |
| Single insider moving value or restoring access | Maker-checker: different approver (DB CHECK), same permission, immutable decided requests (trigger)        | e2e         |
| Double execution of an approved action          | Conditional decision update + idempotent execution keyed by request id                                     | e2e         |
| Self-escalation                                 | Role grants never for oneself (request or approval); no self-suspension                                    | e2e         |
| PII exposure from back-office tools or logs     | AES-256-GCM profile (separate key, AAD per case); decrypted only on audited single-case view; never logged | e2e         |
| Approving sanctioned / restricted applicants    | Restricted-country block; unscreened approvals refused outside local/ci; screener boundary                 | e2e         |
| Reviewer conflict of interest                   | Reviewer ≠ subject (DB CHECK + service)                                                                    | e2e         |
| Support data leakage between users              | Ownership checks return 404; append-only messages                                                          | e2e         |
| Metrics leaking internals                       | Disabled without token; bearer with constant-time compare; blocked at the edge; bounded labels             | e2e         |

## Wallet sign-in controls (ADR-0013)

| Threat                                   | Control                                                                                   | Verified by |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | ----------- |
| Replay of a captured signature           | Single-use Redis nonce, consumed on success; Issued At ≤ 10 min; Expiration Time honoured | e2e         |
| Phishing site relaying a signature       | Domain and URI bound to `WEB_ORIGIN`; mismatches refused                                  | unit + e2e  |
| Forged or malleable signatures           | secp256k1 recovery (`@noble`), high-s rejected, signer must equal the message address     | unit + e2e  |
| Address typos / checksum confusion       | EIP-55 checksums enforced for mixed-case addresses; stored lower-case                     | unit        |
| Account takeover by reassigning a wallet | Wallet address immutable (trigger); unique                                                | e2e         |
| Wallet accounts gaining staff powers     | No password/authenticator for wallet accounts → staff permissions refused (MFA required)  | e2e         |

## Vault controls (Phase 8, testnet)

| Threat                                       | Control                                                                                                    | Verified by          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------- |
| Operator stealing deposits                   | Funds only leave via a withdrawal paid to `user` itself; no admin/upgrade functions                        | Foundry unit + fuzz  |
| Signature replay / malleability / forgery    | Single-use ids, expiry, EIP-712 domain (chain + vault), high-s rejected, signer must be the operator       | Foundry unit + fuzz  |
| Operator disappears                          | Freeze after `freezeDelay` without commits; Merkle escape + late-deposit escape, no operator needed        | Foundry + live chain |
| Double counting at escape                    | Withdrawals keyed by snapshot index; escape subtracts the latest and next index; state lock in the backend | Foundry + live chain |
| Ledger crediting fake or duplicate deposits  | Only confirmed vault events; idempotent keys; custody vs on-chain reconciliation                           | live chain           |
| Unknown on-chain withdrawal (key compromise) | Indexer raises `ChainInvariantError` and halts; alert                                                      | code review          |
| Running against mainnet by mistake           | Chain id allow-list (testnets/local only); raw key refused outside local/ci                                | code + config tests  |
| Reentrancy / non-standard tokens             | Reentrancy guard; balance-delta crediting; checked low-level transfers                                     | Foundry              |

## Security & operations controls (Phase 9)

| Threat                                          | Control                                                                              | Verified by        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------ |
| API compromise used to drain the vault          | Key only in the signer; signer-side per-tx/daily limits, single-use ids, allow-lists | unit + live chain  |
| Forged or replayed signer requests              | HMAC over timestamp+request id+body, 30 s skew, request-id replay rejection          | unit               |
| Signer restart resetting limits                 | Audit log written before responding; state rebuilt from it at start                  | unit               |
| Stolen staff session used for sensitive actions | Step-up TOTP within 5 minutes, replay-protected                                      | unit + integration |
| Staff access from untrusted networks            | Optional CIDR allow-list for staff permissions                                       | unit + integration |
| Unrecoverable data loss                         | Checksummed dumps + restore drill with full reconciliation of the restored copy      | drill run          |
| Silent outages                                  | Prometheus scrape + promtool-validated alert rules + dashboard                       | local stack        |

## Known limitations (must be resolved before any production use)

1. **No production email transport.** Staging and production intentionally refuse to boot.
2. **Secrets come from environment variables.** `MFA_ENCRYPTION_KEY` and
   `CSRF_SECRET` must move to a KMS- or HSM-backed secret manager with rotation.
   The key-versioning scheme for TOTP ciphertext is not yet implemented.
3. **No MFA recovery codes and no WebAuthn/passkeys.** Account recovery after
   losing an authenticator needs a support-driven, identity-verified process (Phase 7).
4. **Staff MFA is not yet mandatory.** Staff roles are flagged `isStaff`; enforcement
   arrives with the admin app (Phase 7).
5. **No breached-password screening** (e.g. HIBP k-anonymity) yet.
6. **Web CSP allows `'unsafe-inline'` scripts**, as required by Next.js without
   nonces. Move to nonce-based CSP.
7. **Rate limits are per IP only.** Per-account and global anomaly detection
   (suspicious login, new device or new country alerts) is planned.
8. **No WAF or bot management.** Expected at the edge in production.
9. **Account lockout can be abused for targeted denial of service.** It is
   mitigated by temporary locks and password-reset unlock; consider risk-based
   challenges (CAPTCHA) instead of hard locks.
10. **Swagger UI**, when enabled locally, relaxes the API CSP. It is disabled by
    default and refused in production.
11. **GitHub Actions are pinned by major tag, not commit SHA.** Pin to SHAs
    before handling production secrets in CI.
12. **No independent security review or penetration test has been performed.**
13. **Ledger guard can be bypassed by a database superuser** (e.g. by setting the
    session flag the posting trigger uses). Reconciliation detects this, but
    production needs separate DB roles: the application role must not own the
    tables or be able to alter triggers, and DBA access must be audited.
14. **Engine DB connection is unencrypted (`NoTls`)** and the engine uses the
    application's DB role. Production needs TLS and a dedicated role limited to
    reading commands and writing events and offsets.
15. **No per-user order rate limits or order-count caps yet** (only per-IP HTTP
    limits). Abuse protection for order entry is planned with the WebSocket
    API (Phase 4).
16. **WebSocket limits are per API instance** (in-memory). Behind several instances,
    per-IP caps multiply; a shared limiter (Redis) is needed for strict global caps.
17. **Reconciliation alerts are logs and audit entries only.** Paging and on-call
    routing arrive with monitoring (Phase 7). Full-scan reconciliation will need
    an incremental design as volume grows.

## Reporting

A coordinated vulnerability disclosure policy (`SECURITY.md`, `security.txt`)
must be published before launch.
