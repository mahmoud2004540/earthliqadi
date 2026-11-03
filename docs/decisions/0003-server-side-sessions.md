# ADR-0003: Opaque server-side sessions instead of JWT

- Status: Accepted
- Date: 2026-11-03

## Context

Users must be able to see and revoke sessions per device. Staff and security
events (password change, MFA disable, suspension) must invalidate access
immediately. JWT access tokens cannot be revoked before they expire without a
server-side denylist, which removes their main advantage.

## Decision

- Browser sessions use a **random 256-bit opaque token** in an `httpOnly`,
  `SameSite=Lax` cookie. Outside local HTTP it is `Secure` and `__Host-`
  prefixed.
- The database stores only `SHA-256(token)`, so a read-only database leak does
  not yield usable sessions.
- Sessions have an **absolute lifetime** (default 12 h) and an **idle timeout**
  (default 30 min). `lastSeenAt` is refreshed at most once per minute.
- Sessions are revoked on logout, password reset (all), password change and MFA
  disable (all others), and user revocation (one or all others). The
  `revokedReason` column records why.
- The account status is checked on every request; a non-`ACTIVE` account
  invalidates its sessions.
- **CSRF:** a signed double-submit token in an `httpOnly` `SameSite=Strict`
  cookie, echoed in `X-CSRF-Token`, together with an `Origin` check. CORS stays
  disabled.
- Programmatic access (Phase 4+) will use **scoped API keys** with HMAC request
  signing, IP allow-lists and separate rate limits, not browser sessions.

## Consequences

- One indexed DB lookup per authenticated request. A Redis cache can be added
  when load requires it, provided invalidation stays immediate.
- The MFA step-up challenge lives in Redis with a 5-minute TTL, at most 5
  attempts and single use. Losing Redis only forces users to sign in again.
