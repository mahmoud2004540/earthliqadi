# Exchange Platform (working name)

A security-first centralized digital asset exchange, built in controlled phases.
The final brand has not been chosen. The display name comes from configuration
(`BRAND_NAME`, `NEXT_PUBLIC_BRAND_NAME`) and never appears in business logic or
database identifiers.

> **Status: pre-launch engineering (Phases 0–8 complete; Phase 9 engineering complete, external audits and legal review pending).**
> Matching and settlement work end to end on **simulated** funds and **test
> tokens on a local/test chain** only. There is no real money anywhere in this
> repository, and the vault contract is not audited. Balances can only be funded with simulated test deposits in
> local/CI environments. The platform is not licensed, audited or insured, and it offers no
> regulated services. See [known issues](docs/operations/known-issues.md).

## What exists today

- **Web app** (`apps/web`): Next.js 15, React 19, Tailwind 4, English-only
  ([ADR-0008](docs/decisions/0008-english-only-ui.md)). Includes the landing page, Security Center, Trust Center (structure
  only), fees, markets, API, risk, legal, about and contact pages; registration,
  email verification, login with TOTP, and password reset; and a dashboard with
  account overview, session/device management, MFA setup and password change.
- **API** (`apps/api`): NestJS 11, PostgreSQL 16 via Prisma 6, Redis 7.
  Covers registration and verification, Argon2id passwords, revocable
  server-side sessions, TOTP MFA, CSRF protection, Redis-backed rate limiting,
  account lockout, RBAC with audited role grants, an append-only audit log,
  health endpoints and OpenAPI.
- **Ledger** (Phase 2): double-entry journal in integer minor units
  (`NUMERIC(38,0)`/`bigint`), database-enforced invariants (balanced entries,
  immutability, non-negative balances), idempotent posting, holds/releases,
  reversals, scheduled reconciliation, and a balances and history dashboard.
  See [ADR-0006](docs/decisions/0006-double-entry-ledger.md).
- **Matching engine** (Phase 3): a deterministic Rust engine
  (`services/matching-engine`) with price-time priority, limit, market, stop,
  IOC, FOK and post-only orders, and self-trade prevention. Verified replay on
  startup. A durable PostgreSQL command/event log, and settlement into the
  ledger (one balanced entry per fill, fees). REST order API; the trading UI
  comes in Phase 4. See [ADR-0007](docs/decisions/0007-matching-engine.md).
- **Market data & terminal** (Phase 4): order book, trades, candles and 24h
  ticker derived only from settled state; WebSocket gateway with freshness
  states; a trading terminal with TradingView Lightweight Charts; Playwright
  end-to-end tests in CI; a load baseline. See
  [ADR-0009](docs/decisions/0009-market-data.md) and
  [performance](docs/operations/performance.md).
- **Throughput and replay** (Phase 5): per-user order limits, batched
  settlement (~5× throughput), and `engine-replay` to verify engine builds
  against recorded history. Paper trading from this phase is **retired**
  ([ADR-0016](docs/decisions/0016-real-markets-only.md)).
- **Perpetual futures on vault collateral**: isolated margin, leverage
  tiers, reduce-only orders, index and mark price (never last trade) from
  spot and on-chain oracle feeds, zero-sum funding, liquidation protected at
  the bankruptcy price, an insurance fund funded only from fees, and a risk
  simulation harness (ADL specified, not live). See
  [ADR-0011](docs/decisions/0011-perpetual-futures.md) and
  [ADR-0016](docs/decisions/0016-real-markets-only.md).
- **Admin, compliance & monitoring** (Phase 7): staff MFA enforcement,
  maker-checker approvals for sensitive actions (database-enforced four eyes),
  identity verification with encrypted profiles (no KYC/sanctions provider is
  claimed), support tickets, notifications, announcements, an admin console,
  and Prometheus metrics with alert rules and runbooks. See
  [ADR-0012](docs/decisions/0012-admin-compliance-monitoring.md).
- **Wallet sign-in, no KYC** ([ADR-0013](docs/decisions/0013-wallet-sign-in-no-kyc.md)):
  customers connect an Ethereum wallet and sign (EIP-4361). There is no
  registration, email or identity documents; the KYC module is off by
  default. Staff use email + password + MFA. Phase 8 moves to a
  **non-custodial** on-chain vault (testnet).
- **Non-custodial vault** (Phase 8, **testnet/local chain only, not audited**):
  `contracts/ExchangeVault.sol` holds deposits; withdrawals are
  operator-signed (EIP-712) and submitted from the user's wallet; balance
  roots are committed on-chain, and an escape hatch lets users withdraw on
  their own if the operator stops. Indexer, custody reconciliation and a
  local Anvil chain in Compose. See
  [ADR-0014](docs/decisions/0014-non-custodial-vault.md).
- **Security & operational readiness** (Phase 9, engineering part): an
  isolated **signer service** with its own limits and audit log (`apps/signer`),
  step-up re-authentication and an admin IP allow-list, verified backup/restore
  drills, a Prometheus/Alertmanager/Grafana profile, and personal data export.
  See [ADR-0015](docs/decisions/0015-security-and-operational-readiness.md) and
  the [production-readiness checklist](docs/operations/production-readiness.md).
- **Shared packages:** zod schemas and the RBAC catalogue (`packages/shared`),
  and environment validation (`packages/config`).
- **Infrastructure:** Dockerfiles, a Compose stack with an nginx edge proxy, a CI
  pipeline (format, lint, typecheck, unit, integration, build, images, audit) and
  CodeQL.

## Quick start

```bash
cp .env.example .env
docker compose up --build -d     # postgres, redis, migrate, api, web, edge
open http://localhost:3000
docker compose logs -f api | grep "DEV MAIL"   # email verification links (dev transport)
```

Hot-reload development, the first staff account and troubleshooting are covered
in [docs/operations/local-development.md](docs/operations/local-development.md).

## Commands

| Command                 | What it does                                         |
| ----------------------- | ---------------------------------------------------- |
| `pnpm install`          | Install (frozen lockfile in CI)                      |
| `pnpm dev`              | API (watch, :4000) + web (Next dev, :3000)           |
| `pnpm check`            | Prettier check + ESLint + typecheck + unit tests     |
| `pnpm test:integration` | API integration tests against PostgreSQL + Redis     |
| `pnpm build`            | Build all packages and apps                          |
| `pnpm db:migrate`       | Apply Prisma migrations (`DATABASE_URL` from `.env`) |

## Repository layout

```
apps/api            NestJS API (modular monolith)
apps/web            Next.js customer app
packages/shared     Shared schemas, RBAC catalogue, types, locales
packages/config     Environment validation
infrastructure/     Dockerfiles, edge proxy, (planned) monitoring
services/           Rust matching engine; (planned) market data, risk engine
docs/               Architecture, ADRs, security, API, operations
tests/              (reserved) cross-service integration and browser e2e suites
```

## Documentation

- [Architecture overview](docs/architecture/overview.md) · [Roadmap & next sprint](docs/architecture/roadmap.md)
- Decisions: [0001 monorepo](docs/decisions/0001-modular-monorepo.md) ·
  [0002 versions](docs/decisions/0002-dependency-versions.md) ·
  [0003 sessions](docs/decisions/0003-server-side-sessions.md) ·
  [0004 edge proxy](docs/decisions/0004-edge-proxy-topology.md) ·
  [0005 shared validation](docs/decisions/0005-shared-zod-validation.md) ·
  [0006 ledger](docs/decisions/0006-double-entry-ledger.md) ·
  [0007 matching engine](docs/decisions/0007-matching-engine.md) ·
  [0008 English-only UI](docs/decisions/0008-english-only-ui.md) ·
  [0009 market data](docs/decisions/0009-market-data.md) ·
  [0010 paper trading & replay](docs/decisions/0010-paper-trading-and-replay.md) ·
  [0011 perpetual futures](docs/decisions/0011-perpetual-futures.md) ·
  [0012 admin, compliance & monitoring](docs/decisions/0012-admin-compliance-monitoring.md) ·
  [0013 wallet sign-in, no KYC](docs/decisions/0013-wallet-sign-in-no-kyc.md) ·
  [0014 non-custodial vault](docs/decisions/0014-non-custodial-vault.md) ·
  [0015 signer, step-up, backups, monitoring](docs/decisions/0015-security-and-operational-readiness.md) ·
  [0016 real markets only](docs/decisions/0016-real-markets-only.md) ·
  [0017 API keys, batch, cancel-all, dead-man](docs/decisions/0017-professional-trading-tools.md) ·
  [0018 fees, referrals, points](docs/decisions/0018-fees-referrals-points.md) ·
  [0019 leader vaults](docs/decisions/0019-leader-vaults.md) ·
  [0020 TWAP, iceberg, RFQ, proof of funds](docs/decisions/0020-large-trader-tools-and-proof.md) ·
  [0021 cross margin](docs/decisions/0021-cross-margin.md) ·
  [0022 access policy](docs/decisions/0022-access-policy.md),
  [0023 Cloudflare edge and OFAC sync](docs/decisions/0023-cloudflare-edge-and-ofac-sync.md),
  [0024 full region block](docs/decisions/0024-full-region-block.md),
  [0025 pro order tools](docs/decisions/0025-pro-order-tools.md),
  [0026 listing request board](docs/decisions/0026-listing-request-board.md)
- Security: [controls & threat model](docs/security/threat-model.md) ·
  [dependency policy](docs/security/dependency-policy.md) ·
  [incident response (draft)](docs/security/incident-response.md)
- [API reference](docs/api/README.md)
- Operations: [local development](docs/operations/local-development.md) ·
  [known issues](docs/operations/known-issues.md) ·
  [runbooks](docs/operations/runbooks.md) ·
  [production readiness](docs/operations/production-readiness.md) ·
  [backup & recovery](docs/operations/backup-recovery.md)

## Ground rules

- Never use real customer funds or production credentials in development.
- Money is integer minor units (`bigint`); never binary floating point.
- Never publish unverified claims (licences, audits, reserves, partners, liquidity).
- Real-money operation requires specialist legal and compliance review and the
  required authorizations (e.g. MiCA CASP) for each jurisdiction and product.
