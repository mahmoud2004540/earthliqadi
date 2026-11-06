# ADR-0021: Cross-margin mode (free balance backs positions)

- Status: Accepted
- Date: 2026-11-07
- Context: product brief §3c. Large traders want their whole balance to
  stand behind their positions, not each position alone.

## Decision

`POST /v1/perp/margin-mode {mode: "isolated" | "cross"}` sets
`users.perp_margin_mode`. Every switch is audited.

**Isolated (the default).** Unchanged (ADR-0011): each position risks only
its own margin.

**Cross.** On every risk tick, before the liquidation check, a position
whose equity is below **125% of its maintenance margin** receives free
balance (`USER_AVAILABLE` of the quote asset). The amount brings equity back
to the **initial margin for its current notional at mark**, capped by what
is free.

- **Mechanics:** the top-up is a normal `MARGIN_TRANSFER` ledger entry,
  posted under the position lock (lock order positions → ledger) and
  audited (`perp.cross_margin.top_up`).
- **Liquidation:** a position is liquidated only once the free balance can
  no longer keep it above maintenance. After that point, liquidation,
  bankruptcy pricing and loss coverage are unchanged.
- **Properties (tested):** the top-up never moves more than is free, and
  with enough free balance the position is never left liquidatable.

**Vault accounts** stay isolated, because their free balance pays
redemptions.

## Consequences and limits

- In cross mode a losing position can consume the whole free balance. The
  UI explains this when switching.
- **Not portfolio margin:** unrealised profit on one position does not
  support another, spot holdings do not offset perpetual risk, and only the
  quote asset counts as collateral (no multi-collateral haircuts). Those
  need an account-level risk engine and remain open work. They are not
  claimed.
