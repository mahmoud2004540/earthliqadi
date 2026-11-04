# ADR-0015: Isolated signer, step-up authentication, backups, monitoring stack, data export

- Status: Accepted
- Date: 2026-11-04
- Phase: 9 (the technical part; external audits and legal work are not engineering deliverables)

## Decision

### 1. Isolated operator signer (`apps/signer`)

The vault operator key leaves the API.

- **Service:** a small, separate service (own container, own volume) holds the
  key and exposes exactly two operations: sign an EIP-712 withdrawal, and
  send `commitState`. There is **no generic "sign this" endpoint**.
- **Authentication:** HMAC-SHA256 over `timestamp.requestId.body`, with a
  30-second skew window and request-id replay rejection.
- **Policy, enforced by the signer itself** (so a compromised API cannot
  exceed it):
  - one chain and one vault;
  - an allow-listed token set with **per-withdrawal and per-UTC-day limits**;
  - an expiry window measured from chain time (the contract's clock);
  - single-use withdrawal ids;
  - rate-limited state commits that must be sequential with the on-chain
    index.
- **Audit:** an append-only JSONL log. Each signature is written **before**
  it is returned. On restart the log rebuilds the used ids and daily totals,
  so limits survive restarts.
- **API side:** `OperatorSigner` with a local implementation (local/ci only,
  as before) and a remote one. A policy refusal becomes `409 LIMIT_EXCEEDED`
  and the ledger hold rolls back.
- **Configuration rule:** outside local/ci a vault configuration requires
  `SIGNER_URL`, and raw operator keys are refused.
- **Next steps:** an HSM/KMS backend (the key never in process memory),
  separate host or network policy, mTLS, and alerting on refusals.

### 2. Admin hardening

- **Step-up authentication:** `POST /v1/auth/step-up {code}` records a fresh
  TOTP check on the session (replay-protected). Endpoints marked
  `@RequireStepUp()` need one within `STEP_UP_WINDOW_SECONDS` (default 5
  minutes): approvals (request, approve, reject), user suspension, KYC
  decisions, market creation and halt/resume, and asset creation.
  Otherwise they answer `403 STEP_UP_REQUIRED`. The web client asks for the
  code and retries once.
- **IP allow-list:** with `ADMIN_IP_ALLOWLIST` (IPv4/IPv6 CIDRs), staff
  permissions only work from those networks (`403 IP_NOT_ALLOWED`).
  Customer permissions are unaffected.
- Every denial is audited.

### 3. Backups and restore drill

- `scripts/backup.sh`: `pg_dump` custom format plus a SHA-256 file.
- `scripts/restore-drill.sh`:
  - verifies the checksum;
  - restores into a throwaway database;
  - compares row counts of the money tables;
  - runs a **full ledger reconciliation on the restored copy**;
  - drops the database.

  A backup only counts once a drill succeeds.

- Dumps contain personal data: encrypt, restrict access, and store off-host.
- Point-in-time recovery (WAL archiving) is the next step for production.

### 4. Monitoring stack (`--profile monitoring`)

- Prometheus (scraping `/metrics` with the bearer token from a file),
  Alertmanager and Grafana (with a provisioned "Exchange overview"
  dashboard). Ports are loopback-only and images are pinned by digest.
- Alert rules are validated with `promtool`. Alertmanager routing is
  local-only until an on-call integration exists.

### 5. Personal data export

`GET /v1/me/export` returns one JSON document with everything held about the
account:

- profile and roles, sessions, balances, ledger postings;
- orders, trades, positions;
- vault deposits and withdrawals;
- decrypted identity data (if any), support messages, notifications;
- the user's own activity log.

Secrets are never included. Each export is audited. Deletion requests are
handled through support, because ledger, trade and audit records have legal
retention periods.

## Consequences

- An API compromise can no longer sign arbitrary withdrawals: at most the
  signer's daily limits.
- A stolen staff session cannot perform sensitive actions without the
  authenticator.
- Restores are tested, and operational health is visible.
- Still external, and **not claimed**:
  - smart-contract audit;
  - penetration test;
  - legal and regulatory analysis;
  - HSM/KMS procurement;
  - on-call staffing.

  See `docs/operations/production-readiness.md`.
