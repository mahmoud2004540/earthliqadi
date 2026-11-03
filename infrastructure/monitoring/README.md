# Monitoring (planned)

Not implemented yet. Current observability:

- Structured JSON logs (pino) with request ids, and redaction of cookies,
  authorization and CSRF headers
- `/health/live` and `/health/ready` for orchestrator probes
- The append-only `audit_logs` table for security events

Planned (Phase 7, earlier where a phase needs it):

- OpenTelemetry traces and metrics (HTTP latency, error rates, auth failures,
  rate-limit hits)
- Prometheus + Grafana dashboards, with alert rules routed to on-call
- Security alerts: login-failure spikes, lockouts, permission denials,
  role grants, MFA disables
- From Phase 2: ledger reconciliation mismatches (page immediately)
