# ADR-0030: Public status page, incident reports and withdrawal timeline

- Status: Accepted (Phase A of the trusted-exchange strategy, 2026-11-07)
- Date: 2026-11-07

## Context

People keep funds where they can see that things work and where problems
are admitted openly. A freeze with no explanation is what customers read as
failure.

## Decision

### Status page (`GET /v1/status`, public; `/status` on the web)

Component states are derived from live signals. None is self-declared.

| Component                | Signal                    | Degraded when                                         |
| ------------------------ | ------------------------- | ----------------------------------------------------- |
| Trading                  | each market's data state  | any market delayed or halted                          |
| Vault balance roots      | the latest committed root | older than 2 × `VAULT_STATE_INTERVAL_SECONDS` + 1 min |
| Deposits and withdrawals | the chain indexer cursor  | not updated for 10 minutes                            |
| Sanctions screening      | the latest OFAC sync      | older than 2 × `SANCTIONS_SYNC_HOURS`                 |

**Outage:** trading is an outage when every market is halted.

**A missing signal shows as degraded, never as fine.** A component with no
configuration and no data is not shown.

**Overall state** is the worst component, raised by open incidents:

- a major incident raises it to degraded;
- a critical incident raises it to outage.

### Incidents

Staff with `announcements:manage` and a fresh step-up can:

- open an incident: title, impact (minor, major or critical) and a first
  update;
- post updates: investigating, identified, monitoring, resolved.

**Rules:**

- Updates are append-only, enforced by a database trigger. What was
  published stays published.
- A resolved incident cannot be reopened; open a new one instead.
- Everything is audited.
- The page shows open incidents and those resolved in the last 90 days.

### Withdrawal timeline (dashboard)

Each withdrawal shows its steps:

1. requested;
2. signed (funds held);
3. one of the following:
   - waiting for the wallet, with the expiry time and what happens if it
     passes;
   - confirmed on-chain, with the transaction hash;
   - expired, with the funds returned.

## Consequences

- **The page is only as honest as its signals.** Engine and settlement
  delays, vault commits, indexing and sanctions sync are covered. API error
  rates are not yet; they come with the monitoring stack (Phase 9).
- **Incident text is written by staff and published verbatim.** Review it
  before posting, since it cannot be edited afterwards.
