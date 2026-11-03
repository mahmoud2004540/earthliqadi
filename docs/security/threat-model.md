# Security controls and threat model (Phases 1–2)

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
14. **Reconciliation alerts are logs and audit entries only.** Paging and on-call
    routing arrive with monitoring (Phase 7). Full-scan reconciliation will need
    an incremental design as volume grows.

## Reporting

A coordinated vulnerability disclosure policy (`SECURITY.md`, `security.txt`)
must be published before launch.
