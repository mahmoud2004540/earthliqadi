# Backup and recovery (design requirements; not yet implemented)

Nothing in this document is operational yet. It records requirements to
implement and test before any real data is stored.

## Requirements

- **PostgreSQL** is the system of record:
  - Continuous WAL archiving with point-in-time recovery (target RPO ≤ 1 min for
    ledger data, set with Phase 2)
  - Encrypted backups, stored in a separate account/region, immutable (object lock)
  - Restore drills at least quarterly, timed against the RTO target; results recorded
  - Backups must preserve `audit_logs` and (later) journal tables exactly. Restores
    must not reorder or rewrite them.
- **Redis** holds only ephemeral data (rate limits, MFA challenges). It needs no
  backup, and its loss must be harmless (users may need to sign in again).
- **Secrets** (KMS keys) have their own recovery procedure, with documented
  separation of duties.
- **DORA alignment:** document RTO and RPO per service, dependencies, and test
  evidence.

## Local development

`docker compose down -v` deletes the local volumes. A quick local dump:

```bash
docker compose exec postgres pg_dump -U exchange -Fc exchange_dev > backup.dump
docker compose exec -T postgres pg_restore -U exchange -d exchange_dev --clean < backup.dump
```
