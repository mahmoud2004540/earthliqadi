# ADR-0029: Recurring purchases and sales

- Status: Accepted (Phase A of the trusted-exchange strategy, 2026-11-07)
- Date: 2026-11-07
- Extends: ADR-0020, ADR-0025 (algo orders)

## Decision

`kind: 'recurring'` is an algo order with these parameters:

| Parameter         | Meaning                                              |
| ----------------- | ---------------------------------------------------- |
| `side`            | buy or sell                                          |
| `amount`          | per run: quote to spend (buy) or base to sell (sell) |
| `intervalSeconds` | 1 hour to 30 days                                    |
| `runs`            | 1 to 1000                                            |
| `slippageBps`     | 0.1% to 5%                                           |
| `limitPrice`      | optional: never buy above it, never sell below it    |

**Each run** sends one IOC limit order at the best opposite price ± slippage,
capped by the limit:

- a buy is sized as `amount ÷ price`, rounded down to lots;
- a sell is sized as `amount`.

**Skipped runs.** A run is skipped, and still counted, when:

- there is no opposite price;
- the best price is beyond the limit;
- the size would be below the market minimum.

The reason is shown as `Run N skipped: …`. The platform never guesses a
price.

**Failure.** A run that cannot be funded stops the order with the reason,
the same as other algo orders.

Each run is an ordinary order with its own funds check, fees and access
gate (ADR-0022, ADR-0024).

## Consequences

- **This is an execution tool, not advice or a managed product.** It buys
  what the user set, when the user set. Counsel should confirm the
  marketing wording per jurisdiction.
- **Timing.** Runs fire on the algo poll (about 1 s) after their due time.
- **Placeholder sizes.** For buys, the order's lot counts are placeholders;
  the size is decided per run.
