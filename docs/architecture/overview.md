# Architecture overview

> Status: **Phases 0–2 implemented** (foundation, identity, access control, double-entry ledger).
> Nothing in this repository handles real money. See [roadmap](roadmap.md).

## 1. Goals that drive the architecture

1. **Correctness of money before speed of features.** The ledger (Phase 2) is the
   source of truth for balances. The matching engine never mutates balances
   directly; it emits fills that the ledger posts with idempotency keys.
2. **Security in every layer.** Every request is authenticated by default and
   authorised by explicit permission. Security-relevant actions are recorded in an
   append-only audit log, and the database enforces that it stays append-only.
3. **Honesty.** No fabricated data, claims, liquidity or certifications, either in
   code or on any page.
4. **Start modular, extract when justified.** One API process with clear module
   boundaries. Separate services only where the workload demands it: the matching
   engine (latency, determinism) and later the risk engine and market data.

## 2. System context (current)

```
                 ┌──────────────────────── Docker network ─────────────────────────┐
 Browser ──────► │ edge (nginx) ──/api/*──► api (NestJS) ──► PostgreSQL 16          │
  :3000          │      │                       │         └──► Redis 7             │
                 │      └──── /* ─────► web (Next.js, SSR/SSG)                      │
                 └─────────────────────────────────────────────────────────────────┘
```

- **edge**: the single public entry point. It routes `/api/*` to the API and
  everything else to the web app. It **overwrites** `X-Forwarded-For` with the
  real peer address and assigns `X-Request-Id`. In production this is the load
  balancer or ingress, which also terminates TLS. See
  [ADR-0004](../decisions/0004-edge-proxy-topology.md).
- **web** (`apps/web`): Next.js App Router with English (LTR) and Arabic (RTL).
  Public pages are statically generated. The authenticated dashboard is a client
  component that talks to the API on the same origin.
- **api** (`apps/api`): NestJS modular monolith, REST under `/v1`, with OpenAPI.
- **PostgreSQL**: system of record. Schema is managed by Prisma migrations, plus
  hand-written SQL for constraints and triggers.
- **Redis**: ephemeral state only (rate-limit counters, MFA login challenges,
  email cooldowns). Losing Redis must never lose financial or identity data.

## 3. Repository layout

| Path                        | Purpose                                                                     |
| --------------------------- | --------------------------------------------------------------------------- |
| `apps/api`                  | NestJS API (auth, account, RBAC, audit, health, admin read endpoints)       |
| `apps/web`                  | Next.js customer web app                                                    |
| `apps/admin`                | _Planned (Phase 7)_: separate back-office app, separately deployed          |
| `packages/shared`           | zod schemas, RBAC catalogue, DTO types, locales, error codes                |
| `packages/config`           | Environment validation (zod) for every process                              |
| `services/*`                | _Planned_: Rust matching engine (Phase 3), risk engine (6), market data (4) |
| `infrastructure/docker`     | Dockerfiles and edge proxy config                                           |
| `infrastructure/monitoring` | _Planned_: metrics, dashboards, alert rules                                 |
| `docs/`                     | Architecture, ADRs, security, API and operations docs                       |

`apps/admin` and `services/*` are deliberately not scaffolded yet. Empty
placeholder apps would suggest functionality that does not exist.

## 4. API internals

Global request pipeline, in order:

1. `helmet` security headers (strict CSP, HSTS, no-referrer, no `X-Powered-By`)
2. JSON body parser (64 KB limit), cookie parser
3. `ThrottlerGuard`: Redis-backed fixed-window limits per client IP. There is a
   default limit plus a stricter `auth` limit on credential endpoints.
4. `CsrfGuard`: unsafe methods need a signed double-submit token, and any
   `Origin` header must match `WEB_ORIGIN`.
5. `SessionAuthGuard`: every route requires a valid session unless it is marked
   `@Public()`.
6. `PermissionsGuard`: enforces `@RequirePermissions(...)`. Denials are audited.
7. `ZodValidationPipe`: validates inputs with the same schemas the frontend uses
   and strips unknown keys.
8. `HttpExceptionFilter`: uniform `{ error: { code, message, requestId } }`
   envelope with no stack traces.

Modules:

| Module    | Responsibility                                                                                |
| --------- | --------------------------------------------------------------------------------------------- |
| `auth`    | Registration, email verification, login, MFA challenge, logout, password reset                |
| `account` | `/v1/me`: profile, sessions (list/revoke), password change, TOTP enrolment                    |
| `rbac`    | Syncs the permission/role catalogue at boot; resolves permissions; audited grants             |
| `audit`   | Append-only audit writes, transactional with the change they describe                         |
| `ledger`  | Assets, double-entry posting, holds/releases, reversals, reconciliation, balances/history API |
| `admin`   | Permission-gated read endpoints (users, audit log). The UI comes in Phase 7.                  |
| `health`  | `/health/live` (process), `/health/ready` (DB + Redis)                                        |
| `mail`    | Development transports only (`log`, `memory`); production is refused at boot                  |

## 5. Data model

Identity (Phase 1): `users`, `sessions`, `verification_tokens`, `roles`,
`permissions`, `role_permissions`, `user_roles`, `audit_logs`.

- Tokens (session, email verification, password reset) are stored only as SHA-256
  hashes.
- TOTP secrets are AES-256-GCM encrypted, with the user id as associated data.
- `audit_logs` has `BEFORE UPDATE/DELETE/TRUNCATE` triggers that raise.

Ledger (Phase 2, [ADR-0006](../decisions/0006-double-entry-ledger.md)): `assets`,
`ledger_accounts`, `journal_entries`, `postings`, `ledger_reconciliation_runs`.

- Amounts are `NUMERIC(38,0)` minor units (TypeScript: `bigint`).
- Database triggers enforce: entries balanced per asset (deferred, at commit);
  immutable journal and postings; balances that change only through postings;
  non-negative balances (`CHECK`); immutable asset code and scale.

Orders, markets and fills arrive with Phase 3.

## 6. Planned components (not implemented)

| Component        | Phase | Notes                                                                                              |
| ---------------- | ----- | -------------------------------------------------------------------------------------------------- |
| Matching engine  | 3     | Rust, single-threaded per market, deterministic, price-time priority, event-sourced input log      |
| Market data      | 4     | Sequenced WebSocket feeds, snapshots + deltas, stale-data detection; last/mark/index kept separate |
| Paper trading    | 5     | Simulated balances in a separate ledger namespace; never mixed with real balances                  |
| Risk engine      | 6     | Mark price from index + funding basis; liquidation never uses last price alone                     |
| Admin app        | 7     | Separate deployment and origin; staff MFA mandatory                                                |
| Custody adapters | 8     | Provider abstraction; no in-house key custody; testnets only during development                    |

An event bus (Kafka/Redpanda) will be introduced only when a measured workload
needs it. Until then, transactional outbox tables in PostgreSQL are the plan for
reliable event publication.
