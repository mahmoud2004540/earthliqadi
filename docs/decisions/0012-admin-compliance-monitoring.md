# ADR-0012: Admin, maker-checker, identity verification, support and monitoring

- Status: Accepted
- Date: 2026-11-03
- Phase: 7

## Context

An exchange is operated by people, and most real-world losses come from
privileged access: a compromised staff account, one person making a
money-moving change alone, or personal data leaking from back-office tools.
Phase 7 adds the back office, so its controls must come first.

## Decision

### Staff accounts require MFA

Every permission except the three customer ones (`account:self:read`,
`account:self:manage`, `trading:trade`) is a **staff permission**. The
permission guard refuses staff permissions with `403 MFA_REQUIRED` unless
the account has TOTP MFA enabled. The denial is audited.

- `STAFF_MFA_REQUIRED` defaults to true, and the configuration refuses to
  boot with false outside local/ci.
- The browser e2e suite enrols staff in MFA like a real person.
- Limitation: the check is per account, not per session (no step-up
  re-authentication yet).

### Maker-checker (four eyes)

Sensitive actions are **requests** that a **different** staff member holding
the same permission must approve. Only then are they executed:

| Action                | Permission            | Notes                                    |
| --------------------- | --------------------- | ---------------------------------------- |
| `market.resume`       | `markets:configure`   | Halting stays single-person (emergency)  |
| `insurance_fund.seed` | `markets:configure`   | Paper only; replaces the direct endpoint |
| `ledger.reversal`     | `ledger:adjust` (new) | The only way to correct the ledger       |
| `user.reactivate`     | `users:manage-status` | Suspension stays single-person           |
| `role.grant`          | `roles:assign`        | Never for oneself (request or approval)  |

Protective actions (halt, suspend) are immediate. Actions that restore
access, move value or grant power need two people.

Enforcement:

- **Database:**
  - `approval_requests_four_eyes_chk`: approver ≠ requester.
  - A trigger makes a request immutable once decided, and its contents
    immutable from the start.
  - No deletes.
- **Service:** both people need the action's permission. A conditional
  update lets only one decision win. Execution is idempotent (ledger keys
  `approval:<id>`, upserts), so a crash between execution and recording
  cannot apply an action twice.
- Requests expire (`APPROVAL_TTL_HOURS`, default 24). The requester can
  cancel. Decisions notify the requester. Everything is audited.

### Identity verification (KYC)

- Users submit a basic profile: legal name, date of birth (18+), country and
  address.
- The profile is encrypted with **AES-256-GCM** under `PII_ENCRYPTION_KEY`,
  bound to the case id (AAD). The key is separate from the MFA key and
  required outside local/ci.
- Only the country code is stored in clear, for screening and limits.
  Profiles are never logged or put in audit metadata.
- A compliance officer reviews each case: approve, reject, or needs-info.
  - The decrypted profile is shown only on the single-case endpoint, and
    every view is audited.
  - Reviewers cannot decide their own case (DB CHECK and service check).
  - One open case per user (partial unique index).
- **Screening:**
  - Restricted countries (`RESTRICTED_COUNTRIES`, which needs legal input)
    block approval.
  - Sanctions/PEP screening sits behind a `SanctionsScreener` boundary.
    **No provider is integrated or claimed.** Every case is `not_screened`,
    and approving an unscreened case is refused outside local/ci.
- Approval sets `users.kyc_level`. `KYC_REQUIRED_FOR_REAL_TRADING` (required
  true outside local/ci) blocks real-asset orders below level 1. Paper
  trading is always open.
- Document upload, liveness checks and enhanced due diligence wait for a
  contracted provider.

### Support, notifications, announcements

- **Tickets:** messages are append-only (trigger). Users see only their own
  tickets (404 for others). Staff cannot answer their own tickets. Staff
  replies notify the user.
- **In-app notifications:** KYC decisions, support replies, approval
  decisions, liquidation start. Email/push delivery waits for a provider.
- **Announcements:** append-only, published by staff with
  `announcements:manage`, listed publicly.

### Admin console

`/admin` in the web app is a client of the same API.

- **All authorisation is enforced by the API.** The page holds no data or
  privileges of its own.
- Sections: overview (health), approvals, KYC review, support, users
  (suspend, reactivation requests), audit log.
- A separate admin origin, IP allow-lists and staff SSO are deferred to
  Phase 9 hardening.

### Monitoring

- `GET /metrics`: Prometheus text format with no extra dependency.
  - Disabled without `METRICS_TOKEN`; requires a bearer token
    (constant-time comparison).
  - Blocked at the edge.
  - Route-template labels only, to keep cardinality bounded.
- Alert rules with runbooks for: reconciliation mismatch or staleness,
  settlement halts and lag, engine backlog, perpetual index staleness and
  risk-engine failures, stuck liquidations, API 5xx rate, long halts, and
  the compliance backlog.

## Consequences

- No single staff member can resume trading, move ledger value, restore a
  suspended account or grant roles.
- A stolen staff password alone gives no back-office access.
- Personal data exists in one encrypted column, readable only through an
  audited endpoint.
- Not done:
  - deployed Prometheus/Alertmanager/Grafana and alert routing;
  - real KYC and sanctions providers;
  - step-up authentication per sensitive action;
  - a separate admin origin;
  - GDPR export and deletion workflows;
  - AML transaction monitoring rules (no real flows exist yet).
