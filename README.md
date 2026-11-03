# Exchange Platform (working name)

A security-first centralized digital asset exchange, built in controlled phases.
The final brand has not been chosen. The display name comes from configuration
(`BRAND_NAME`, `NEXT_PUBLIC_BRAND_NAME`) and never appears in business logic or
database identifiers.

> **Status: pre-launch engineering (Phases 0–1 complete).**
> There is no ledger, no trading, no custody and no real money anywhere in this
> repository. The platform is not licensed, audited or insured, and it offers no
> regulated services. See [known issues](docs/operations/known-issues.md).

## What exists today

- **Web app** (`apps/web`): Next.js 15, React 19, Tailwind 4, English/Arabic
  (LTR/RTL). Includes the landing page, Security Center, Trust Center (structure
  only), fees, markets, API, risk, legal, about and contact pages; registration,
  email verification, login with TOTP, and password reset; and a dashboard with
  account overview, session/device management, MFA setup and password change.
- **API** (`apps/api`): NestJS 11, PostgreSQL 16 via Prisma 6, Redis 7.
  Covers registration and verification, Argon2id passwords, revocable
  server-side sessions, TOTP MFA, CSRF protection, Redis-backed rate limiting,
  account lockout, RBAC with audited role grants, an append-only audit log,
  health endpoints and OpenAPI.
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
services/           (planned) Rust matching engine, market data, risk engine
docs/               Architecture, ADRs, security, API, operations
tests/              (reserved) cross-service integration and browser e2e suites
```

## Documentation

- [Architecture overview](docs/architecture/overview.md) · [Roadmap & next sprint](docs/architecture/roadmap.md)
- Decisions: [0001 monorepo](docs/decisions/0001-modular-monorepo.md) ·
  [0002 versions](docs/decisions/0002-dependency-versions.md) ·
  [0003 sessions](docs/decisions/0003-server-side-sessions.md) ·
  [0004 edge proxy](docs/decisions/0004-edge-proxy-topology.md) ·
  [0005 shared validation](docs/decisions/0005-shared-zod-validation.md)
- Security: [controls & threat model](docs/security/threat-model.md) ·
  [dependency policy](docs/security/dependency-policy.md) ·
  [incident response (draft)](docs/security/incident-response.md)
- [API reference](docs/api/README.md)
- Operations: [local development](docs/operations/local-development.md) ·
  [known issues](docs/operations/known-issues.md) ·
  [backup & recovery](docs/operations/backup-recovery.md)

## Ground rules

- Never use real customer funds or production credentials in development.
- Use fixed-precision decimals for money; never binary floating point (from Phase 2).
- Never publish unverified claims (licences, audits, reserves, partners, liquidity).
- Real-money operation requires specialist legal and compliance review and the
  required authorizations (e.g. MiCA CASP) for each jurisdiction and product.
