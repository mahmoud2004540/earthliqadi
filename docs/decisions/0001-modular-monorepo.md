# ADR-0001: Modular monorepo, modular-monolith API

- Status: Accepted
- Date: 2026-11-03

## Context

The platform will eventually include a web app, an admin app, an API, a Rust
matching engine, a risk engine and market-data services. Early on, the team is
small and the domain model is still changing.

## Decision

- A single **pnpm workspace** monorepo (`apps/*`, `packages/*`; `services/*` later).
- The API is a **NestJS modular monolith**. Modules talk through injected
  services, not HTTP. A module becomes a separate service only when there is a
  measured reason: latency, isolation, independent scaling, or a different
  language runtime.
- The **matching engine will be a separate Rust service** from day one of
  Phase 3. Its determinism and latency needs justify the split.
- Shared contracts (zod schemas, permission catalogue, error codes) live in
  `packages/shared` and are used by both frontend and backend.
- No Turborepo or Nx for now. `pnpm -r` in topological order is enough. We will
  revisit if build times hurt.

## Consequences

- One lockfile, one CI pipeline, atomic cross-cutting changes.
- Module boundaries must be kept by discipline and review. A later ADR may add
  lint rules for import boundaries.
