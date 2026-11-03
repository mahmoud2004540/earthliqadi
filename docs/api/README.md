# API reference (v1)

Interactive OpenAPI documentation is served at `/docs` (JSON at
`/docs/openapi.json`) when `SWAGGER_ENABLED=true`. This is local and development
only, and it is refused in production. Through the local edge proxy the paths
are `http://localhost:3000/api/docs` and `http://localhost:3000/api/v1/...`.

## Conventions

- **Versioning:** URI prefix `/v1`. Health endpoints are unversioned.
- **Authentication:** session cookie (`session`, or `__Host-session` over HTTPS).
  Every endpoint requires it unless marked public.
- **CSRF:** for `POST`/`PUT`/`PATCH`/`DELETE`, first call `GET /v1/auth/csrf`,
  then send its `csrfToken` in the `X-CSRF-Token` header. Requests with a
  foreign `Origin` are rejected.
- **Errors:** `{"error": {"code": "...", "message": "...", "requestId": "...", "details": [...]}}`.
  Codes are listed in `packages/shared/src/api/errors.ts`.
- **Rate limits:** default 120 requests/min per IP; credential endpoints 10/min
  per IP. Exceeding them returns `429 RATE_LIMITED`.
- **Request IDs:** taken from the edge's `X-Request-Id` or generated, and
  returned in error bodies and logs.

## Endpoints

| Method | Path                            | Auth | Permission            | Description                                        |
| ------ | ------------------------------- | ---- | --------------------- | -------------------------------------------------- |
| GET    | `/health/live`                  | —    | —                     | Process liveness                                   |
| GET    | `/health/ready`                 | —    | —                     | DB + Redis readiness (503 when degraded)           |
| GET    | `/v1/auth/csrf`                 | —    | —                     | Issue CSRF token                                   |
| POST   | `/v1/auth/register`             | —    | —                     | Register (always 202, no enumeration)              |
| POST   | `/v1/auth/verify-email`         | —    | —                     | Consume email verification token                   |
| POST   | `/v1/auth/resend-verification`  | —    | —                     | Resend verification (always 202)                   |
| POST   | `/v1/auth/login`                | —    | —                     | Password login → `authenticated` or `mfa_required` |
| POST   | `/v1/auth/login/mfa`            | —    | —                     | Complete login with TOTP code                      |
| POST   | `/v1/auth/logout`               | ✔    | —                     | Revoke current session                             |
| POST   | `/v1/auth/password/forgot`      | —    | —                     | Request reset link (always 202)                    |
| POST   | `/v1/auth/password/reset`       | —    | —                     | Reset with token; revokes all sessions             |
| GET    | `/v1/me`                        | ✔    | `account:self:read`   | Current user, roles, permissions                   |
| GET    | `/v1/me/sessions`               | ✔    | `account:self:read`   | Active sessions (devices)                          |
| DELETE | `/v1/me/sessions/:id`           | ✔    | `account:self:manage` | Revoke one of your sessions                        |
| POST   | `/v1/me/sessions/revoke-others` | ✔    | `account:self:manage` | Revoke all other sessions                          |
| POST   | `/v1/me/password`               | ✔    | `account:self:manage` | Change password; revokes other sessions            |
| POST   | `/v1/me/mfa/totp/setup`         | ✔    | `account:self:manage` | Begin TOTP enrolment (requires password)           |
| POST   | `/v1/me/mfa/totp/enable`        | ✔    | `account:self:manage` | Confirm enrolment with a code                      |
| POST   | `/v1/me/mfa/totp/disable`       | ✔    | `account:self:manage` | Disable (password + code); revokes other sessions  |
| GET    | `/v1/admin/users`               | ✔    | `users:read`          | Paginated users (no secrets); access is audited    |
| GET    | `/v1/admin/audit-logs`          | ✔    | `audit:read`          | Audit log, newest first                            |

## Ledger endpoints (Phase 2)

Amounts are always **decimal strings at the asset's full scale** (e.g. `"0.75000000"`
for BTC with scale 8). They are never JSON numbers.

| Method | Path                               | Auth | Permission          | Description                                                            |
| ------ | ---------------------------------- | ---- | ------------------- | ---------------------------------------------------------------------- |
| GET    | `/v1/assets`                       | —    | —                   | Active assets (code, name, scale). No prices or volumes.               |
| GET    | `/v1/me/balances`                  | ✔    | `account:self:read` | Available / locked / total per active asset                            |
| GET    | `/v1/me/ledger-entries`            | ✔    | `account:self:read` | Own balance changes, newest first (`?limit=&before=`)                  |
| GET    | `/v1/admin/assets`                 | ✔    | `ledger:read`       | All assets, including disabled                                         |
| POST   | `/v1/admin/assets`                 | ✔    | `assets:configure`  | Create asset `{code, name, scale}` (code and scale immutable); audited |
| PATCH  | `/v1/admin/assets/:code/status`    | ✔    | `assets:configure`  | `{status: ACTIVE\|DISABLED}`; audited                                  |
| GET    | `/v1/admin/ledger/accounts`        | ✔    | `ledger:read`       | Accounts of `?ownerUserId=` (or system accounts); access audited       |
| GET    | `/v1/admin/ledger/entries/:id`     | ✔    | `ledger:read`       | Entry with postings; access audited                                    |
| POST   | `/v1/admin/ledger/reconciliations` | ✔    | `ledger:reconcile`  | Run a reconciliation now                                               |
| GET    | `/v1/admin/ledger/reconciliations` | ✔    | `ledger:read`       | Recent reconciliation runs and findings                                |

There is intentionally **no HTTP endpoint that posts journal entries or adjusts
balances**. Holds and releases are internal service calls for the order system
(Phase 3). Staff adjustments need maker-checker approval (Phase 7). Error codes
specific to the ledger: `INSUFFICIENT_FUNDS` (422) and `IDEMPOTENCY_CONFLICT` (409).

## Trading endpoints (Phase 3)

Prices are quote per one whole base unit and quantities are base units, both as
decimal strings on the market grid (`tickSize`, `lotSize`). Orders are
**asynchronous**: `POST /v1/orders` returns `202` once funds are held and the
order is queued; poll `GET /v1/orders/:id` for status (`pending_new` → `open` →
`partially_filled` → `filled`, or `cancelled` / `rejected`). WebSocket updates
arrive in Phase 4.

| Method | Path                               | Auth | Permission          | Description                                                                |
| ------ | ---------------------------------- | ---- | ------------------- | -------------------------------------------------------------------------- |
| GET    | `/v1/markets`                      | —    | —                   | Market definitions (no prices or volumes)                                  |
| POST   | `/v1/orders`                       | ✔    | `trading:trade`     | Place an order (202; 200 when replaying the same `clientOrderId`)          |
| GET    | `/v1/orders`                       | ✔    | `account:self:read` | `?status=open\|closed\|all&market=&limit=`                                 |
| GET    | `/v1/orders/:id`                   | ✔    | `account:self:read` | One of your orders                                                         |
| DELETE | `/v1/orders/:id`                   | ✔    | `trading:trade`     | Request cancellation (202); allowed while a market is halted               |
| PATCH  | `/v1/orders/:id`                   | ✔    | `trading:trade`     | `{remainingQuantity}`: reduce in place, keeping time priority (202)        |
| GET    | `/v1/me/trades`                    | ✔    | `account:self:read` | Your fills (side, maker/taker, price, quantity, fee, fee asset)            |
| POST   | `/v1/admin/markets`                | ✔    | `markets:configure` | `{base, quote, tickSize, lotSize, minQuantity?, makerFeeBps, takerFeeBps}` |
| PATCH  | `/v1/admin/markets/:symbol/status` | ✔    | `markets:configure` | `{status: ACTIVE\|HALTED}`; halting blocks new orders                      |
| GET    | `/v1/admin/engine/status`          | ✔    | `reports:read`      | Per market: commands enqueued/processed, events emitted/settled, hash      |

Order fields: `market`, `clientOrderId` (idempotency key, unique per user),
`side` (`buy`/`sell`), `type` (`limit`/`market`/`stop_limit`/`stop_market`),
`timeInForce` (`gtc`/`ioc`/`fok`/`post_only`; market types default to and
require `ioc`/`fok`), `price` (required for limit types and as the **protection
price** for market and stop-market buys), `stopPrice` (stop types only), and
`quantity`.

Holds: buys hold `price × quantity` in quote; sells hold `quantity` in base.
Fees (basis points, rounded down) are taken from the asset you receive.

## Example (curl through the edge)

```bash
B=http://localhost:3000/api
CSRF=$(curl -s -c jar -b jar $B/v1/auth/csrf | jq -r .csrfToken)
curl -s -c jar -b jar -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"email":"me@example.test","password":"a long passphrase 123","acceptTerms":true}' \
  $B/v1/auth/register
```

Planned for later phases: scoped API keys with HMAC signing, public market data
REST/WebSocket, trading endpoints, and FIX readiness.
