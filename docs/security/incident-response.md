# Incident response (initial draft)

> Draft for the engineering phase. It must be reviewed and expanded with legal,
> compliance and operations owners before launch: DORA incident classification
> and reporting timelines, GDPR breach notification (72 h), and regulator and
> customer communication.

## Severity levels

| Level | Examples                                                                    | Response             |
| ----- | --------------------------------------------------------------------------- | -------------------- |
| SEV1  | Suspected loss or theft of funds or keys, ledger inconsistency, auth bypass | Immediate; all hands |
| SEV2  | Data exposure, active account takeover campaign, prolonged outage           | < 1 h                |
| SEV3  | Degraded service, single-account compromise, failed control                 | Same business day    |

## First-response checklist

1. **Declare**: open an incident channel, name an incident commander and a scribe, start a timeline.
2. **Contain** (choose what fits):
   - Revoke sessions: `UPDATE sessions SET revoked_at = now(), revoked_reason = 'incident' WHERE …`.
     This must be audited; the procedure becomes an admin action in Phase 7.
   - Suspend affected accounts (status `SUSPENDED` invalidates sessions on the next request).
   - Rotate `CSRF_SECRET`. All CSRF tokens become invalid and clients refetch automatically.
   - Block abusive IPs or ranges at the edge.
   - From Phase 3: halt trading per market (`operations:emergency`). From Phase 8:
     pause withdrawals.
3. **Preserve evidence**: export `audit_logs` and the API logs for the window, and
   snapshot the database. Never modify audit records; they are append-only by design.
4. **Eradicate and recover**: fix the root cause, deploy, verify with tests, and
   restore service gradually.
5. **Notify**: follow the legal and regulatory notification matrix (to be defined).
6. **Review**: blameless post-incident review within 5 business days; publish to
   the Trust Center incident history where appropriate.

## Useful queries

```sql
-- Recent failed logins by IP
SELECT ip_address, count(*) FROM audit_logs
WHERE action = 'auth.login' AND outcome = 'FAILURE' AND occurred_at > now() - interval '1 hour'
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

-- Everything a user did (or was done to them)
SELECT * FROM audit_logs WHERE actor_user_id = $1 OR target_id = $1::text ORDER BY id;
```
