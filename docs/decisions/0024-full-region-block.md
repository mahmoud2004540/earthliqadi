# ADR-0024: Full block for restricted locations; counsel-approved list

- Status: Accepted (owner and counsel, 2026-11-06)
- Date: 2026-11-06
- Amends: ADR-0022 (what a restricted location may do), ADR-0023 (the list)

## Context

**Counsel's decision.** Counsel approved the suggested restricted list (ADR-0023). Counsel also decided
that restricted locations must be locked out completely, as the reference
venue's interface does.

**What ADR-0022 did.** ADR-0022 left sign-in, reduce-only orders, cancels and
withdrawals open from restricted locations.

## Decision

### 1. The list is the default

`RESTRICTED_COUNTRIES` defaults to `US,CU,IR,KP`. `RESTRICTED_SUBDIVISIONS`
defaults to:

| Code    | Territory      |
| ------- | -------------- |
| `CA-ON` | Ontario        |
| `UA-43` | Crimea         |
| `UA-40` | Sevastopol     |
| `UA-14` | Donetsk region |
| `UA-09` | Luhansk region |

The constants live in `packages/config/src/env.ts`. A deployment can
override them, but cannot forget them. Because of the defaults, staging and
production need both edge headers configured (ADR-0023).

Region checks stay off where no header is configured (local and CI).

### 2. `GEO_RESTRICTED_MODE=block_all` (default)

A request from a restricted location is refused with **451
`REGION_RESTRICTED`**:

- It is refused by middleware **before authentication**, on every route.
  That covers sign-in, account data, market data, orders, cancels and
  withdrawals.
- The market-data WebSocket upgrade is refused with 451 as well.

Only these remain reachable:

- `GET /v1/access`, which explains the block;
- the health probes and metrics.

The web app shows a full-screen notice instead of the interface. The terms
page stays readable.

`reduce_only` keeps the behaviour of ADR-0022 for deployments whose counsel
wants it.

### 3. Funds are still never trapped

The platform never holds collateral. The vault contract's escape hatch
(ADR-0014) lets every user withdraw committed balances on-chain without the
platform, from anywhere. The block notice and the terms say so.

## Consequences

- **Open positions cannot be managed from a restricted location.** A user who
  travels to a restricted location cannot close positions through the
  platform there, and the positions stay exposed to liquidation. The terms
  tell users to close positions before travelling. This is counsel's
  accepted trade-off.
- **Staff are covered too.** Staff cannot use the platform from a restricted
  location either. The block runs before authentication, so no role is
  exempt.
- **The limits of ADR-0023 still apply:**
  - VPNs defeat location checks;
  - citizenship is enforced by the terms only.
