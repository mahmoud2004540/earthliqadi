# Known issues and incomplete features (Sprints 1–3)

This is the honest list of what does **not** exist yet or is limited. Anything
not described as implemented in the docs should be treated as absent.

## Not implemented (by design, later phases)

- Real deposits, withdrawals and custody (Phase 8). Balances can only be funded with **simulated** test deposits in local/CI.
- Market data feeds, WebSocket API, trading terminal and charts (Phase 4). Orders work through the REST API only; there is no trading UI yet.
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

### Ledger (Sprint 2)

- No staff adjustment endpoint: corrections are reversals only (CLI/service). Maker-checker adjustments come in Phase 7.
- No fee accounts in use yet; `FEE_REVENUE` exists in the chart but nothing posts to it until trading (Phase 3).
- Reconciliation scans the whole ledger each run. This is fine at development scale; it needs an incremental/checkpointed design later.
- Hot accounts (one row per asset for simulated custody now, fee revenue later) serialise writers. Sharding or batching is planned with the matching engine (ADR to follow).
- The dashboard shows balances at full asset scale without fiat valuation. No prices exist yet, by design.

### Trading (Sprint 3)

- Engine startup replays the full command history per market; snapshot loading
  (already implemented and tested in the library) will be wired in when logs grow.
- Some engine operations are O(n): cancel within a price level, scanning pending
  stops, and the set of known order ids (which grows without bound). This is
  acceptable at development scale and noted for optimisation.
- The PostgreSQL transport adds milliseconds of latency; it has not been load-tested yet (Sprint 4).
- No order expiry (GTD), iceberg orders or trailing stops.
- A market buy needs an explicit protection price, because there is no
  reference price yet.
- If settlement hits an invariant violation, that market's settlement stops
  (logged as `SETTLEMENT_HALTED`) and needs manual investigation. There is no
  automated paging yet.
- **Engine container image not built in the development sandbox:** Docker Hub
  rate-limited the Rust and Debian base images. The engine binary is built and
  tested natively (and spawned by the integration tests); CI builds the image.

## Environment notes

- `pnpm dev` (Next.js proxy) lets clients spoof their IP via `X-Forwarded-For`.
  This is acceptable only on localhost (ADR-0004). Use the Compose stack for
  realistic behaviour.
- Docker builds in networks with TLS interception need the proxy CA injected at
  build time. The committed Dockerfiles assume a normal network.
