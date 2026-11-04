#!/usr/bin/env bash
# Logical backup of the platform database (ADR-0015, runbook "Backups").
# Writes backups/<UTC timestamp>.dump (pg_dump custom format) + a SHA-256 file.
# The dump contains personal data: store it encrypted, access-controlled, off-host.
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${POSTGRES_DB:-exchange_dev}"
USER="${POSTGRES_USER:-exchange}"
mkdir -p backups
ts="$(date -u +%Y%m%dT%H%M%SZ)"
out="backups/${ts}.dump"
docker compose exec -T postgres pg_dump -U "$USER" -d "$DB" -Fc --no-owner > "$out"
sha256sum "$out" > "$out.sha256"
echo "$out ($(du -h "$out" | cut -f1))"
