# Monitoring (Phase 7)

What exists:

- **Metrics:** `GET /metrics` on the API, in Prometheus text format. It is
  enabled only when `METRICS_TOKEN` is set and requires
  `Authorization: Bearer <token>`. The edge proxy returns 404 for
  `/api/metrics`, so it is reachable only on the internal network.
  - Instruments: HTTP request count and duration (labelled by route template,
    never the raw path), settlement failures, risk-engine tick failures.
  - Gauges computed at scrape time: engine backlog, settlement lag, market
    halted, perpetual index stale, reconciliation result and age, insurance
    fund balances, positions liquidating, approvals/KYC/support queues.
- **Alert rules:** `prometheus/alerts.yml`. Every alert links to a section of
  [`docs/operations/runbooks.md`](../../docs/operations/runbooks.md).
- **Scrape config:** `prometheus/prometheus.yml` reads the token from a file
  (never commit it).
- Structured JSON logs (pino) with request ids and redaction; `/health/live`
  and `/health/ready`; the append-only audit log.
- **Admin console overview** (`/admin`): the same health snapshot for staff.

Not yet running (honest gaps):

- No Prometheus, Alertmanager or Grafana service is deployed. The Compose
  stack does not start one, and alert routing (pager, chat) is not
  configured. A dashboard definition is not committed yet.
- No tracing (OpenTelemetry).
- Security alerts (login-failure spikes, role grants, MFA disables) are in
  the audit log but have no alert rules yet.

Local check:

```bash
METRICS_TOKEN=$(openssl rand -hex 24) docker compose up -d --no-build api
docker compose exec api wget -qO- --header "Authorization: Bearer $METRICS_TOKEN" http://localhost:4000/metrics | head
```
