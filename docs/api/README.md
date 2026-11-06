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

## Market data (Phase 4)

Derived only from settled state ([ADR-0009](../decisions/0009-market-data.md)).
Every snapshot carries `seq` (the settlement sequence) and a freshness `status`
of `live`, `delayed` or `halted`.

| Method | Path                          | Auth | Description                                                 |
| ------ | ----------------------------- | ---- | ----------------------------------------------------------- |
| GET    | `/v1/markets/tickers`         | —    | 24h ticker for every market                                 |
| GET    | `/v1/markets/:symbol/ticker`  | —    | Last, 24h open/high/low/change/volume, best bid/ask, status |
| GET    | `/v1/markets/:symbol/book`    | —    | L2 book `?depth=1..100` (`[price, quantity]` levels)        |
| GET    | `/v1/markets/:symbol/trades`  | —    | Recent fills `?limit=` (price, quantity, taker side, time)  |
| GET    | `/v1/markets/:symbol/candles` | —    | OHLCV `?interval=1m\|5m\|15m\|1h\|4h\|1d&limit=`            |

### WebSocket `/ws` (through the edge: `/api/ws`)

The `Origin` header must match the web origin.

```jsonc
// client → server
{"op":"subscribe","channel":"book","market":"BTC-USDT"}
{"op":"subscribe","channel":"candles","market":"BTC-USDT","interval":"1m"}
{"op":"subscribe","channel":"orders","market":"BTC-USDT"}   // private: session cookie required
{"op":"unsubscribe","channel":"book","market":"BTC-USDT"}
{"op":"ping"}
// server → client
{"type":"book","data":{"market":"BTC-USDT","seq":"42","bids":[["99","1.5"]],"asks":[],"status":{"state":"live",...}}}
{"type":"trades","market":"BTC-USDT","snapshot":false,"data":[{"seq":"43","price":"100","quantity":"0.5","takerSide":"buy","executedAt":"..."}]}
{"type":"error","code":"UNAUTHENTICATED","message":"..."}
```

- The server sends a snapshot on subscribe, then a new snapshot whenever `seq`
  advances or freshness changes. Trades are incremental after the first
  snapshot.
- Limits: 10 connections per IP, 50 subscriptions per connection, 20 messages
  per second, 4 KB per message, heartbeat every 20 s. Private subscriptions are
  closed (code `4401`) when the session ends.
- After reconnecting, re-subscribe: the server answers with fresh snapshots
  (there are no deltas to stitch on the `book` channel).
- `book_diff` channel (ADR-0017):
  - the server first sends one `book` snapshot (top 50 levels, with `seq`);
  - after that, it sends
    `{type:"book_diff", prevSeq, seq, bids, asks, status}` with only the
    changed levels;
  - a quantity of `"0"` means the level left the view;
  - apply a diff only if `prevSeq` equals the `seq` you hold. If it does not,
    resubscribe to get a fresh snapshot.

## Order limits

- `429 RATE_LIMITED` above `ORDER_RATE_LIMIT_PER_SECOND` (default 10 per
  user, for place/cancel/reduce).
- `409 LIMIT_EXCEEDED` at `MAX_OPEN_ORDERS_PER_MARKET` (default 200).
- Paper trading (`/v1/paper/faucet`) is retired (ADR-0016).
- Markets expose `vaultBacked`; assets expose `chainToken`.

## Perpetual futures

| Method | Path                               | Auth | Permission          | Description                                                            |
| ------ | ---------------------------------- | ---- | ------------------- | ---------------------------------------------------------------------- |
| GET    | `/v1/perp/markets/:symbol/stats`   |      | public              | Mark, index, predicted/last funding, next funding, `indexStale`        |
| GET    | `/v1/perp/markets/:symbol/funding` |      | public              | Funding history (`?limit=`)                                            |
| GET    | `/v1/perp/insurance-fund`          |      | public              | Insurance fund balances                                                |
| GET    | `/v1/perp/positions`               | ✔    | `account:self:read` | Positions with entry, mark, estimated liquidation and bankruptcy price |
| POST   | `/v1/perp/leverage`                | ✔    | `trading:trade`     | `{market, leverage}`; only while flat with no open orders (`409`)      |
| POST   | `/v1/perp/margin`                  | ✔    | `trading:trade`     | `{market, amount}`: adds isolated margin from the available balance    |

- Perpetual symbols end in `-PERP`. `POST /v1/admin/markets` accepts
  `kind: "perpetual"` with a `perp` configuration (tiers, funding, index
  sources, bands; see `perpConfigSchema`). Outside local/ci the quote asset
  must be vault-backed. Index sources: `spot`, `oracle` (Chainlink-compatible
  feed), and `simulated` (local/ci tests only). Insurance fund top-ups go
  through the `insurance_fund.seed` approval and move collected fees.
- `POST /v1/orders` on a perpetual market requires `price` (a limit price, or a
  protection price for market orders), accepts `reduceOnly`, and returns:
  - `400` outside the price band, beyond the bankruptcy price, or above the
    tier size for the leverage;
  - `409` while the position is liquidating or when there is no reliable
    mark (except for reduce-only orders).
- `MarketDto` gains `kind` and `perp`; `OrderDto` gains `reduceOnly` and
  `liquidation`; `BalanceDto` gains `margin`.

## Admin, compliance and support (Phase 7)

Staff permissions require MFA on the account (`403 MFA_REQUIRED` otherwise).

| Method | Path                                         | Permission                           | Description                                                     |
| ------ | -------------------------------------------- | ------------------------------------ | --------------------------------------------------------------- |
| GET    | `/v1/me/verification`                        | `account:self:read`                  | KYC level and latest case                                       |
| POST   | `/v1/me/verification`                        | `account:self:manage`                | Submit identity details (encrypted at rest)                     |
| GET    | `/v1/me/notifications`                       | `account:self:read`                  | Notifications and unread count                                  |
| POST   | `/v1/me/notifications/read`                  | `account:self:manage`                | `{ids?}`: mark read (all if omitted)                            |
| GET    | `/v1/me/tickets`, `/v1/me/tickets/:id`       | `account:self:read`                  | Own tickets                                                     |
| POST   | `/v1/me/tickets`, `.../:id/messages`         | `account:self:manage`                | Open a ticket, reply                                            |
| GET    | `/v1/announcements`                          | public                               | Latest announcements                                            |
| POST   | `/v1/announcements`                          | `announcements:manage`               | Publish                                                         |
| GET    | `/v1/admin/approvals`                        | `approvals:read`                     | `?status=pending\|all`                                          |
| POST   | `/v1/admin/approvals`                        | `approvals:read` + action permission | `{action, payload, reason}` (see ADR-0012 table)                |
| POST   | `/v1/admin/approvals/:id/approve`            | action permission                    | By a different staff member; executes the action                |
| POST   | `/v1/admin/approvals/:id/reject\|cancel`     | action permission / requester        | Reject (other staff) or cancel (requester)                      |
| POST   | `/v1/admin/users/:id/suspend`                | `users:manage-status`                | `{reason}`: immediate; revokes sessions                         |
| GET    | `/v1/admin/users/:id`                        | `users:read`                         | Profile, roles, balances, positions (audited)                   |
| GET    | `/v1/admin/kyc`, `/v1/admin/kyc/:id`         | `kyc:review`                         | Queue; single case with decrypted profile (audited)             |
| POST   | `/v1/admin/kyc/:id/decision`                 | `kyc:review`                         | `{decision: approve\|reject\|needs_info, note}`                 |
| GET    | `/v1/admin/tickets`, `/v1/admin/tickets/:id` | `support:tickets:manage`             | Queue and ticket                                                |
| POST   | `/v1/admin/tickets/:id/messages\|close`      | `support:tickets:manage`             | Reply, close                                                    |
| GET    | `/v1/admin/health`                           | `reports:read`                       | Markets, reconciliation, insurance funds, queues                |
| GET    | `/metrics`                                   | bearer `METRICS_TOKEN`               | Prometheus (internal only; 404 at the edge and without a token) |

`POST /v1/admin/perp/insurance-fund` was removed: seeding now goes through
maker-checker (`insurance_fund.seed`). Real-asset orders return
`403 KYC_REQUIRED` when `KYC_REQUIRED_FOR_REAL_TRADING=true`.

## Wallet sign-in (ADR-0013)

| Method | Path                    | Auth   | Description                                                                                                           |
| ------ | ----------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/auth/wallet/nonce` | public | `{nonce, domain, uri, expiresInSeconds}`: single-use, 5 minutes                                                       |
| POST   | `/v1/auth/wallet/login` | public | `{message, signature}`: EIP-4361 message + `personal_sign`; creates the account on first use; sets the session cookie |

- `CurrentUserDto` gains `walletAddress` (EIP-55); `email` is null for wallet
  accounts.
- KYC endpoints answer `404` unless `KYC_ENABLED=true`.

## Vault (Phase 8, testnet / local chain only)

| Method | Path                      | Auth | Permission          | Description                                                                                                          |
| ------ | ------------------------- | ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/vault/config`        |      | public              | `{enabled, chainId, vault, tokens[], freezeDelaySeconds, faucet}`                                                    |
| POST   | `/v1/vault/withdrawals`   | ✔    | `trading:trade`     | `{asset, amount}`: holds the amount and returns the EIP-712 withdrawal + signature (`call`) for the wallet to submit |
| GET    | `/v1/vault/withdrawals`   | ✔    | `account:self:read` | Own withdrawals (`signed` / `executed` / `expired`)                                                                  |
| GET    | `/v1/vault/proof`         | ✔    | `account:self:read` | Latest committed state index, root, and the user's leaves with Merkle proofs                                         |
| POST   | `/v1/vault/faucet`        | ✔    | `trading:trade`     | Local chain only: test ETH for gas + test tokens                                                                     |
| GET    | `/v1/admin/vault/custody` | ✔    | `ledger:read`       | Ledger `VAULT_CUSTODY` vs on-chain vault balances at the indexed block                                               |

Deposits have no endpoint: users call `deposit(token, amount)` on the vault
from their wallet, and the indexer credits them after `CHAIN_CONFIRMATIONS`.
Vault-backed markets accept orders from wallet accounts only.

## Security & privacy (Phase 9)

| Method | Path               | Auth | Description                                                                                                |
| ------ | ------------------ | ---- | ---------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/auth/step-up` | ✔    | `{code}`: fresh TOTP for this session; required by sensitive staff actions within `STEP_UP_WINDOW_SECONDS` |
| GET    | `/v1/me/export`    | ✔    | Personal data export (JSON attachment; no secrets; audited)                                                |

New errors: `403 STEP_UP_REQUIRED`, `403 IP_NOT_ALLOWED` (staff permissions
outside `ADMIN_IP_ALLOWLIST`), `409 LIMIT_EXCEEDED` when the signer's policy
refuses a withdrawal.

The signer service (`apps/signer`, internal only) exposes `POST
/v1/sign/withdrawal` and `POST /v1/commit-state` with HMAC headers
`x-signer-timestamp`, `x-signer-request-id`, `x-signer-signature`.

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

## Professional trading (ADR-0017)

| Method | Path                        | Auth           | Description                                                             |
| ------ | --------------------------- | -------------- | ----------------------------------------------------------------------- |
| GET    | `/v1/me/api-keys`           | session        | List keys                                                               |
| POST   | `/v1/me/api-keys/challenge` | session        | `{label, publicKey, scopes, allowedIps?, expiresInDays}` → text to sign |
| POST   | `/v1/me/api-keys`           | session        | `{challengeId, signature}` (wallet `personal_sign`) → key               |
| DELETE | `/v1/me/api-keys/:id`       | session        | Revoke (permanent)                                                      |
| POST   | `/v1/orders/batch`          | session or key | `{orders: [...]}` up to 20; per-item `status`, `order` or `error`       |
| POST   | `/v1/orders/cancel-all`     | session or key | `{market?}` → `{cancelRequested}`                                       |
| POST   | `/v1/orders/cancel-after`   | session or key | `{timeoutSeconds}` (0 disables, 5–86400) → `{deadline}`                 |

Signed requests (agent keys) use these headers:

```
X-API-Key: <key id>
X-API-Timestamp: <unix ms>            # within ±30 s of server time
X-API-Signature: base64(ed25519_sign(`${timestamp}\n${METHOD}\n${path_with_query}\n${raw_body}`))
```

- **Scopes.** `read` covers orders, trades, balances, ledger history and
  positions. `trade` adds placing, cancelling and reducing orders, batch,
  cancel-all, cancel-after, leverage and margin.
- **Refused routes.** Any other route answers `403 API_KEY_NOT_ALLOWED`. This
  includes withdrawals and key management.
- **Errors.**
  - `401 API_KEY_INVALID`: unknown, expired or revoked key, bad signature,
    replayed signature, or a timestamp outside the allowed clock skew.
  - `403 IP_NOT_ALLOWED`: the request came from outside the key's allow-list.
