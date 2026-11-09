# Local development

## Prerequisites

- Node.js 22 LTS (`.nvmrc`) and pnpm 10.28 (`corepack enable`)
- Docker with Compose v2
- Optional: a local PostgreSQL 16 and Redis 7 instead of Docker

## Option A: full stack in Docker (production-like topology)

```bash
cp .env.example .env
docker compose up --build -d
docker compose ps                              # all services healthy
open http://localhost:3000                     # edge proxy → web + /api
docker compose logs -f api | grep "DEV MAIL"   # verification / reset links
```

The `migrate` service applies Prisma migrations and exits before `api` starts.
The API is **not** published on a host port; use `http://localhost:3000/api/...`.

## Option B: hot reload with pnpm

```bash
cp .env.example .env
docker compose up -d postgres redis   # or run them natively
pnpm install
pnpm db:migrate                       # applies migrations using .env
pnpm dev                              # API :4000 (watch) + web :3000 (Next dev)
```

In this mode Next.js proxies `/api` to the API (development only; see ADR-0004).
Swagger UI: http://localhost:4000/docs when `SWAGGER_ENABLED=true`.

## Creating the first staff account

There are no default administrator accounts. Register and verify a normal
account, then grant a role with the audited CLI:

```bash
pnpm --filter @platform/api build
pnpm --filter @platform/api cli:grant-role -- --email you@example.test --role administrator --reason "local setup"
# Docker: docker compose exec api node dist/cli/grant-role.js --email … --role … --reason …
```

## Test assets and simulated funds (local/CI only)

No assets are seeded (listing an asset is a business decision). For local work:

```bash
# Docker:
docker compose exec api node dist/cli/ledger.js create-asset --code BTC --name "Bitcoin (test asset)" --scale 8
docker compose exec api node dist/cli/ledger.js sim-deposit --email you@example.test --asset BTC --amount 0.5
docker compose exec api node dist/cli/ledger.js reconcile     # exit code 2 on mismatch
# pnpm mode:
pnpm --filter @platform/api build && pnpm --filter @platform/api cli:ledger -- reconcile
```

`sim-deposit` posts a `SIMULATED_DEPOSIT` against the `SIMULATED_CUSTODY`
account. It is refused unless `DEPLOY_ENV` is `local` or `ci`, and it is
audited. Reconciliation also runs every `LEDGER_RECONCILIATION_INTERVAL_SECONDS`
(0 disables it).

## Matching engine and trading (local)

With Docker Compose the `engine` service runs automatically. In pnpm mode, run
the engine yourself (Rust toolchain from `services/matching-engine/rust-toolchain.toml`):

```bash
DATABASE_URL=postgresql://exchange:dev-only-postgres-password@localhost:5432/exchange_dev \
  cargo run --manifest-path services/matching-engine/Cargo.toml --bin engine-server
```

Create a market (as a user with `markets:configure`, e.g. the `risk_officer`
role) with `POST /v1/admin/markets`, fund test users with `ledger sim-deposit`,
then place orders with `POST /v1/orders`. `GET /v1/admin/engine/status` shows
engine backlog and settlement lag.

`pnpm test:integration` builds the engine (`cargo build`) and spawns it against
the test database. It needs a Rust toolchain.

## Engine replay

```bash
# Verify the running engine build reproduces all recorded history (exit 0 = identical)
docker compose exec engine engine-replay
```

## Markets

`chain deploy` (next section) creates the vault-backed markets:

- `TBTC-TUSD` (spot);
- `TBTC-TUSD-PERP` (perpetual, index = spot mid).

Further perpetuals use `POST /api/v1/admin/markets` with `kind: "perpetual"` and a
`perp` configuration (see `perpConfigSchema`). Index sources can be:

- `spot` (a market here);
- `oracle` (`{"type":"oracle","address":"0x…","label":"BTC / USD"}`, a
  Chainlink-compatible feed on the configured chain);
- `simulated` (automated tests only).

The risk engine runs every `PERP_RISK_POLL_MS` (0 disables it). The insurance fund grows from
liquidation fees and from maker-checker top-ups of collected fees
(`insurance_fund.seed`).

Paper trading is retired (ADR-0016).

## Vault on the local chain (ADR-0014)

```bash
docker compose up -d chain                                  # Anvil, chain id 31337
docker compose exec api node dist/cli/chain.js deploy       # TUSD + TBTC test tokens and the vault (add --cap TUSD=100000 for a deposit limit)
docker compose exec api node dist/cli/chain.js custody      # ledger vs on-chain
(cd contracts && ./forge.sh test)                           # contract tests (Foundry image)
```

Sign in with a wallet, open **Dashboard → Balances**, use **Get test tokens
& gas**, then deposit/withdraw. MetaMask: add network `http://localhost:8545`
(chain id 31337); the panel offers to add it.

## Backups, monitoring and the signer (ADR-0015)

```bash
scripts/backup.sh                                   # backups/<ts>.dump + .sha256
scripts/restore-drill.sh backups/<ts>.dump          # restore + full reconciliation
scripts/monitoring-up.sh                            # Prometheus :9090, Alertmanager :9093, Grafana :3001
docker compose --profile signer up -d signer        # isolated signer (set SIGNER_* in .env first)
```

## Quality checks

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test   # = pnpm check
pnpm test:integration    # needs PostgreSQL + Redis, see below
pnpm build
```

Integration tests run against a **dedicated** database whose name must contain
`test`. The default is
`postgresql://exchange:exchange_dev_password@localhost:5432/exchange_test`;
override it with `TEST_DATABASE_URL` and `TEST_REDIS_URL`. Migrations are
applied automatically. Tests never truncate data (the audit log is append-only);
they use unique emails instead.

```bash
# With the compose postgres (credentials from .env.example):
docker compose exec postgres createdb -U exchange exchange_test
TEST_DATABASE_URL=postgresql://exchange:dev-only-postgres-password@localhost:5432/exchange_test \
  pnpm test:integration
```

## Troubleshooting

| Symptom                                                             | Fix                                                                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API exits with `Invalid environment configuration` (exit 78)        | The message lists the variable names at fault. Compare with `.env.example`.                                                                                         |
| `CSRF_INVALID` on every POST                                        | Call `GET /v1/auth/csrf` first and send `X-CSRF-Token`; keep cookies (`-c/-b` with curl).                                                                           |
| `429 RATE_LIMITED` while testing locally                            | All local requests share one IP. Wait a minute, or clear dev keys: `docker compose exec redis sh -c "redis-cli --scan --pattern 'rl:*' \| xargs -r redis-cli del"`. |
| Login says email not verified                                       | Find the link in the API log (`DEV MAIL`) and open it.                                                                                                              |
| `ACCOUNT_LOCKED`                                                    | Wait `LOGIN_LOCKOUT_MINUTES`, or reset the password (reset clears the lock).                                                                                        |
| Prisma: `Can't reach database server`                               | Is `postgres` healthy? Is `DATABASE_URL` pointing at `localhost` (pnpm mode) or `postgres` (inside Docker)?                                                         |
| Port 5432 / 6379 / 3000 already in use                              | Stop the local service, or change the published port in `docker-compose.yml`.                                                                                       |
| Image build fails fetching packages behind a TLS-intercepting proxy | Add the proxy CA to the build (e.g. a BuildKit secret appended to `/etc/ssl/certs/ca-certificates.crt` plus `NODE_EXTRA_CA_CERTS`).                                 |
| `audit_logs is append-only` error                                   | Intended. Never delete audit rows; append a correcting entry instead.                                                                                               |
