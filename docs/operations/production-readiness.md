# Production readiness checklist

Honest status before any real funds. "Done" means implemented and tested in
this repository. "External" means it needs people, contracts or decisions
outside engineering. **No item marked external has been done or is claimed.**

## Security

| Item                                                            | Status                                    |
| --------------------------------------------------------------- | ----------------------------------------- |
| Double-entry ledger, DB invariants, reconciliation              | Done                                      |
| Staff MFA, step-up for sensitive actions, admin IP allow-list   | Done                                      |
| Maker-checker for value-moving / access-restoring actions       | Done                                      |
| Operator key in an isolated signer with limits and audit log    | Done (software key)                       |
| Operator key in an HSM/KMS                                      | External                                  |
| Audit preparation (100% coverage, Slither triaged, brief)       | Done (`docs/security/audit-readiness.md`) |
| Smart-contract audit of `ExchangeVault`                         | External                                  |
| Contract-level deposit cap (launch guard, ADR-0033)             | Done                                      |
| Public testnet support, reorg halt, 5+ confirmations (ADR-0034) | Done; hosting is external (owner)         |
| Penetration test (web, API, admin, signer)                      | External                                  |
| Bug bounty programme                                            | External                                  |
| Secrets in a secret manager with rotation                       | To do (Phase 10 infra)                    |
| Separate admin origin and staff SSO                             | To do                                     |

## Operations

| Item                                                               | Status                     |
| ------------------------------------------------------------------ | -------------------------- |
| Metrics endpoint, alert rules (promtool-validated), runbooks       | Done                       |
| Prometheus/Alertmanager/Grafana stack (local profile)              | Done                       |
| Alert routing to an on-call rotation                               | External (staffing + tool) |
| Backups with a verified restore drill                              | Done (logical dumps)       |
| Point-in-time recovery (WAL archiving), off-site encrypted storage | To do                      |
| Load test on production-like infrastructure                        | To do                      |
| Incident response exercise                                         | External                   |

## Legal and compliance (ADR-0013)

| Item                                                    | Status                     |
| ------------------------------------------------------- | -------------------------- |
| Jurisdiction analysis for a no-KYC, non-custodial venue | External (counsel)         |
| Geo-restriction (edge country header, ADR-0022)         | Done; list needs counsel   |
| Cloudflare edge location + subdivisions (ADR-0023)      | Done; Cloudflare to set up |
| Wallet sanctions list screening (ADR-0022)              | Done; OFAC auto (ADR-0023) |
| Automatic sanctions list updates / provider             | External (contract)        |
| Terms-of-use acceptance gate (ADR-0022)                 | Done; text is a draft      |
| Terms of use, risk disclosures, privacy policy          | External (counsel)         |
| Personal data export                                    | Done                       |
| Deletion / retention policy                             | External (counsel) + to do |

## Product

| Item                                                       | Status                               |
| ---------------------------------------------------------- | ------------------------------------ |
| Spot matching, settlement, market data, terminal           | Done                                 |
| Real spot and perpetuals on vault collateral, oracle index | Done (testnet)                       |
| Vault deposits/withdrawals on a test chain, escape hatch   | Done (testnet)                       |
| Mainnet deployment                                         | Blocked by every external item above |
