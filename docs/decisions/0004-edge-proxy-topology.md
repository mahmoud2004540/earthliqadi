# ADR-0004: Edge proxy in front of web and API; API never exposed directly

- Status: Accepted
- Date: 2026-11-03

## Context

Rate limiting, account-lockout analysis and audit logs depend on the client IP.
Behind proxies, the IP comes from `X-Forwarded-For` (XFF), and it can only be
trusted when every hop in front of the API is a proxy we control that overwrites
or appends the header correctly.

The first Sprint 1 build proxied `/api` through the Next.js server (a `rewrites`
rule). An end-to-end test showed that **Next.js forwards a client-supplied XFF
unchanged**. A client could send `X-Forwarded-For: <anything>`, be recorded with
that IP, and rotate it to evade per-IP rate limits.

## Decision

- An **edge reverse proxy** is the only public component. Locally this is nginx
  in Docker Compose; in production it is a load balancer or ingress that also
  terminates TLS.
  - `/api/*` is routed directly to the API with the prefix stripped. Everything
    else goes to the web app.
  - The edge **overwrites** `X-Forwarded-For` with `$remote_addr`, and sets
    `X-Request-Id`.
- The API trusts exactly `TRUST_PROXY_HOPS` proxies (1 behind the edge) and is
  **not published** on any host port.
- The Next.js `/api` rewrite is enabled **only in development** (`next dev`), as
  a convenience for local work without Docker.
- Web and API share one origin, so cookies stay first-party and CORS stays off.

## Consequences

- Deployments must keep the API unreachable except through the edge. This is a
  deployment checklist item and should be enforced with network policy.
- If more proxy layers are added (for example a CDN in front of the load
  balancer), `TRUST_PROXY_HOPS` must be updated and the outer layer must also
  manage XFF correctly.
- In local `pnpm dev`, the client IP can be spoofed via XFF. That is acceptable
  only because it runs on localhost with development data.
