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
