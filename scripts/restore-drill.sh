#!/usr/bin/env bash
# Restore drill: proves a backup is usable. Restores into a throwaway database,
# compares row counts with the source, and runs a full ledger reconciliation on
# the restored copy. Exit code 0 = the backup restores to a consistent ledger.
#   scripts/restore-drill.sh backups/20261104T120000Z.dump
set -euo pipefail
cd "$(dirname "$0")/.."
dump="${1:?usage: restore-drill.sh <dump file>}"
DB="${POSTGRES_DB:-exchange_dev}"
USER="${POSTGRES_USER:-exchange}"
PASS="${POSTGRES_PASSWORD:-dev-only-postgres-password}"
drill="restore_drill_$(date -u +%s)"

sha256sum -c "$dump.sha256"
docker compose exec -T postgres createdb -U "$USER" "$drill"
trap 'docker compose exec -T postgres dropdb -U "$USER" --if-exists "$drill" >/dev/null' EXIT
docker compose exec -T postgres pg_restore -U "$USER" -d "$drill" --no-owner < "$dump"

tables="users ledger_accounts journal_entries postings orders trades positions audit_logs"
for t in $tables; do
  src=$(docker compose exec -T postgres psql -U "$USER" -d "$DB" -Atc "select count(*) from $t")
  dst=$(docker compose exec -T postgres psql -U "$USER" -d "$drill" -Atc "select count(*) from $t")
  printf '%-18s source=%-8s restored=%s\n' "$t" "$src" "$dst"
  # The source keeps changing; the restored copy may only be behind, never ahead.
  [ "$dst" -le "$src" ] || { echo "restored copy has MORE rows in $t"; exit 1; }
done

# Full reconciliation on the restored database (no workers, nothing else touched).
docker compose exec -T \
  -e DATABASE_URL="postgresql://$USER:$PASS@postgres:5432/$drill" \
  api node dist/cli/ledger.js reconcile
echo "restore drill OK ($drill)"
