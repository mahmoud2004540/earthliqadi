# Known issues and incomplete features (Sprint 1)

This is the honest list of what does **not** exist yet or is limited. Anything
not described as implemented in the docs should be treated as absent.

## Not implemented (by design, later phases)

- Financial ledger, balances, deposits, withdrawals and custody (Phases 2 and 8)
- Matching engine, order entry, market data, trading terminal and charts (Phases 3–5)
- Perpetual futures, risk engine, liquidation, insurance fund and ADL (Phase 6)
- Admin application, KYC/AML workflows, support tickets, notifications and
  announcements (Phase 7)
- API keys, IP allow-lists, institutional accounts beyond a schema enum, VIP fees,
  FIX (Phase 4+)
- Monitoring and alerting stack: metrics, dashboards, alert routing
  (`infrastructure/monitoring/` is a placeholder)
- Trust Center content: the structure exists; every item is "Not yet published"

## Functional gaps in what was built

- **Email delivery:** only `log` (prints links) and `memory` (tests) transports.
  Staging and production refuse to boot until a real provider is integrated.
- **MFA:** TOTP only. No recovery codes, no WebAuthn, no QR code rendering (the
  setup key is shown as text and the `otpauth://` URI is returned by the API).
- **Site header** is session-agnostic: it shows "Sign in" even when signed in.
  The dashboard has its own sign-out button.
- **Account deletion and data export** (GDPR rights) are not implemented.
- **Legal pages** contain placeholders stating that the documents are unpublished.
- **Session list** shows raw user-agent strings; there is no device naming or
  geolocation yet.
- **Backups:** none are configured for local Compose volumes. Production backup
  and restore is not yet designed or tested (see `backup-recovery.md`).
- **Response schemas** are not included in the OpenAPI document; only request
  bodies are.
- **E2E browser tests** are not part of CI yet. UI flows were verified manually
  with Playwright during Sprint 1.

## Environment notes

- `pnpm dev` (Next.js proxy) lets clients spoof their IP via `X-Forwarded-For`.
  This is acceptable only on localhost (ADR-0004). Use the Compose stack for
  realistic behaviour.
- Docker builds in networks with TLS interception need the proxy CA injected at
  build time. The committed Dockerfiles assume a normal network.
