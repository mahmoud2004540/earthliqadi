# Services (planned, not yet implemented)

Independent, separately deployed services will live here when their phase begins:

| Service           | Phase | Language | Purpose                                                              |
| ----------------- | ----- | -------- | -------------------------------------------------------------------- |
| `matching-engine` | 3     | Rust     | Deterministic price-time-priority matching, one sequencer per market |
| `market-data`     | 4     | TBD      | Sequenced order book/trade feeds, candles, WebSocket fan-out         |
| `risk-engine`     | 6     | TBD      | Margin, mark/index price, funding, liquidation, ADL                  |

They are intentionally not scaffolded now. See
`docs/architecture/overview.md` §6 and `docs/architecture/roadmap.md`.
