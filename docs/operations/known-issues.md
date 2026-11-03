# Known issues and incomplete features (Sprints 1–7)

This is the honest list of what does **not** exist yet or is limited. Anything
not described as implemented in the docs should be treated as absent.

## Not implemented (by design, later phases)

- Real-asset deposits and withdrawals: only **test tokens on a local/test chain** exist (Phase 8); no real asset is supported.
- API keys, IP allow-lists, institutional accounts beyond a schema enum, VIP fees,
  FIX (Phase 4+)
- Deployed monitoring stack: Prometheus/Alertmanager/Grafana are not running
  and alerts are not routed (metrics endpoint, rules and runbooks exist)
- Trust Center content: the structure exists; every item is "Not yet published"

## Functional gaps in what was built

- **Email delivery:** only `log` (prints links) and `memory` (tests) transports.
  Staging and production refuse to boot until a real provider is integrated.
- **MFA:** TOTP only. No recovery codes, no WebAuthn, no QR code rendering (the
  setup key is shown as text and the `otpauth://` URI is returned by the API).
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

### Market data and terminal (Sprint 4)

- **Settlement throughput is the current bottleneck** under load (see
  `performance.md`); during bursts the book can lag matching by seconds and is
  then flagged `delayed`.
- Book updates are full snapshots (depth ≤ 50), not deltas. Candles are computed
  per request; no materialised candle table yet.
- No mark or index price for spot (not needed until perpetuals in Phase 6).
- No mobile-optimised terminal layout yet (the panels stack on narrow screens but
  the experience is desktop-first).
- The private WebSocket channel carries order updates only. Balances are
  refreshed over REST when an order update arrives.

### Paper trading and simulation (Sprint 5)

- The open-order cap is checked outside the order transaction, so a concurrent
  burst can exceed it by the number of in-flight requests (abuse control, not a
  financial invariant).
- `engine-replay` re-runs whole histories. Snapshot-based incremental replay
  will be needed as logs grow.
- Paper markets currently use the same fee schedule mechanism as real markets
  (configurable per market). No paper leaderboard or reset feature yet.
- Reports and Proof of Reserves (later phases) must filter `is_paper = false`.

### Perpetual futures (Sprint 6, paper only)

- **Paper only by design.** Real-money derivatives are refused by the database.
- **ADL and an insurance-fund backstop are not live.** They are specified and
  property-tested in the simulation harness only. If a fill ever realises a
  loss larger than the margin plus the insurance fund, that market's
  settlement halts for investigation.
- Index sources are internal spot markets or labelled **simulated** feeds;
  external feeds arrive with integrations (Phase 8).
- Isolated margin only: no cross margin, no margin removal, no TP/SL
  attached orders.
- The risk engine runs on a timer inside the API process. Liquidation latency
  is one or two ticks (`PERP_RISK_POLL_MS`, default 1 s) plus engine and
  settlement time.
- A reduce-only order can still race a shrinking position. The risk tick
  cancels reduce-only orders that no longer fit, but a fill in between can
  open a small position funded only by the fee hold. That position is then
  liquidated normally.
- Adding margin uses a time-based idempotency key, so a client retry can
  add twice. Client-supplied idempotency keys are planned.
- Mark and funding are pushed over REST polling (2 s), not WebSocket.

### Admin, compliance and support (Sprint 7)

- **No KYC or sanctions provider is integrated or claimed.** Review is
  manual. Unscreened cases cannot be approved outside local/ci. There is no
  document upload or liveness check.
- No AML transaction monitoring rules yet (there are no real deposits or
  withdrawals to monitor).
- Staff MFA is checked per account, not per session (no step-up
  re-authentication before sensitive actions).
- The admin console is served from the same origin as the customer app. A
  separate origin, IP allow-lists and staff SSO are planned for Phase 9.
- Notifications are in-app only (no email or push).
- GDPR data export and deletion are still missing.
- After `docker compose up --force-recreate api`, restart `edge`: nginx
  caches the API container's IP address.

### Wallet sign-in and no-KYC model (ADR-0013)

- **Legal review is required before any real funds.** The platform does not
  verify identities. Operating with real money needs a non-custodial design
  (Phase 8), jurisdiction-specific legal advice, geo-restrictions and wallet
  sanctions screening (Phase 9). None of these exist yet.
- No geo-restriction is enforced (needs a trusted GeoIP signal at the edge).
- Ethereum (EIP-4361) only; no Solana or other chains, and no
  smart-contract wallet signatures (ERC-1271) yet.
- There is no account recovery for wallet accounts by design.
- Support and notifications work in-app for every account; wallet users get
  no email notifications (they have no email).

### Vault (Sprint 8, testnet only)

- **The contract is not audited.** Testnets and the local chain only.
- The operator key is a raw key from the environment (local/ci only). A
  signing service is required elsewhere (Phase 9).
- The operator is trusted for liveness and for correct roots. A wrong root
  could understate balances; users should keep their latest proof.
- Reorgs deeper than `CHAIN_CONFIRMATIONS` are not handled (local chain has
  none). Public testnets need a higher confirmation setting and a reorg plan.
- One EVM chain at a time; ERC-20 test tokens only (no native ETH).
- After an Anvil reset, the stored deployment no longer exists on-chain:
  redeploy with `chain deploy --suffix X` (asset codes stay linked to their
  original token permanently).

## Environment notes

- `pnpm dev` (Next.js proxy) lets clients spoof their IP via `X-Forwarded-For`.
  This is acceptable only on localhost (ADR-0004). Use the Compose stack for
  realistic behaviour.
- Docker builds in networks with TLS interception need the proxy CA injected at
  build time. The committed Dockerfiles assume a normal network.
