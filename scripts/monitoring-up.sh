#!/usr/bin/env bash
# Starts Prometheus, Alertmanager and Grafana (local, loopback-only ports).
# The API's METRICS_TOKEN (from .env) is written to a gitignored file that
# Prometheus reads as its bearer token.
set -euo pipefail
cd "$(dirname "$0")/.."
token="$(grep -E '^METRICS_TOKEN=' .env | cut -d= -f2-)"
[ -n "$token" ] || { echo "Set METRICS_TOKEN in .env (32+ characters) first"; exit 1; }
# Prometheus runs as an unprivileged user: the file must be readable by it.
# Local only; production mounts the token as a container secret instead.
printf '%s' "$token" > infrastructure/monitoring/prometheus/metrics-token
chmod 0644 infrastructure/monitoring/prometheus/metrics-token
docker compose up -d --no-build api
docker compose --profile monitoring up -d prometheus alertmanager grafana
echo "Prometheus http://localhost:9090 · Alertmanager http://localhost:9093 · Grafana http://localhost:3001"
