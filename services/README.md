# Services

| Service           | Phase | Language | Status          | Purpose                                                      |
| ----------------- | ----- | -------- | --------------- | ------------------------------------------------------------ |
| `matching-engine` | 3     | Rust     | **Implemented** | Deterministic price-time-priority matching (ADR-0007)        |
| `market-data`     | 4     | TBD      | Planned         | Sequenced order book/trade feeds, candles, WebSocket fan-out |
| `risk-engine`     | 6     | TBD      | Planned         | Margin, mark/index price, funding, liquidation, ADL          |

## matching-engine

```bash
cd services/matching-engine
cargo test                     # scenario + property tests
cargo clippy --all-targets -- -D warnings
DATABASE_URL=postgresql://exchange:dev-only-postgres-password@localhost:5432/exchange_dev \
  cargo run --bin engine-server # single active instance; others wait as standby
```

- `src/book.rs`: order book and matching rules. Pure: no I/O, clocks or randomness.
- `src/sequencer.rs`: contiguous event numbers and a SHA-256 chain over commands and events.
- `src/bin/engine-server.rs`: PostgreSQL I/O, advisory lock, verified replay on
  start, and atomic event and offset writes.
