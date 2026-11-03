import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Prisma, type LedgerReconciliationRun, type ReconciliationTrigger } from '@prisma/client';
import type Redis from 'ioredis';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { REDIS } from '../infrastructure/redis/redis.module';
import { toMinorUnits } from './ledger-domain';

export type ReconciliationFinding =
  | {
      kind: 'BALANCE_MISMATCH';
      accountId: string;
      assetId: string;
      projected: string;
      computed: string;
    }
  | { kind: 'NEGATIVE_BALANCE'; accountId: string; assetId: string; balance: string }
  | { kind: 'UNBALANCED_ENTRY'; entryId: string; assetId: string; net: string }
  | { kind: 'ENTRY_TOO_FEW_POSTINGS'; entryId: string; postings: number }
  | { kind: 'TRIAL_BALANCE_NONZERO'; assetId: string; net: string };

/**
 * Independently recomputes the ledger from postings and compares it with the
 * balance projection and the double-entry invariants. Reads a single
 * REPEATABLE READ snapshot so concurrent postings never cause false alarms.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async run(
    trigger: ReconciliationTrigger,
    actorUserId: string | null = null,
  ): Promise<LedgerReconciliationRun> {
    const startedAt = new Date();
    const { findings, accountsChecked, entriesChecked } = await this.prisma.$transaction(
      async (tx) => {
        const accounts = await tx.$queryRaw<
          {
            id: string;
            asset_id: string;
            allow_negative: boolean;
            projected: string;
            computed: string;
          }[]
        >`
          SELECT a."id", a."asset_id", a."allow_negative", a."balance"::text AS "projected",
                 COALESCE(SUM(CASE WHEN p."direction" = a."normal_side" THEN p."amount" ELSE -p."amount" END), 0)::text AS "computed"
            FROM "ledger_accounts" a
            LEFT JOIN "postings" p ON p."account_id" = a."id"
           GROUP BY a."id"`;
        const unbalanced = await tx.$queryRaw<
          { entry_id: string; asset_id: string; net: string }[]
        >`
          SELECT "entry_id"::text, "asset_id",
                 SUM(CASE WHEN "direction" = 'DEBIT' THEN "amount" ELSE -"amount" END)::text AS "net"
            FROM "postings" GROUP BY "entry_id", "asset_id"
          HAVING SUM(CASE WHEN "direction" = 'DEBIT' THEN "amount" ELSE -"amount" END) <> 0`;
        const thin = await tx.$queryRaw<{ id: string; n: number }[]>`
          SELECT e."id"::text, count(p."id")::int AS "n"
            FROM "journal_entries" e LEFT JOIN "postings" p ON p."entry_id" = e."id"
           GROUP BY e."id" HAVING count(p."id") < 2`;
        const trial = await tx.$queryRaw<{ asset_id: string; net: string }[]>`
          SELECT "asset_id", SUM(CASE WHEN "direction" = 'DEBIT' THEN "amount" ELSE -"amount" END)::text AS "net"
            FROM "postings" GROUP BY "asset_id"
          HAVING SUM(CASE WHEN "direction" = 'DEBIT' THEN "amount" ELSE -"amount" END) <> 0`;
        const [{ count }] = await tx.$queryRaw<
          [{ count: number }]
        >`SELECT count(*)::int AS "count" FROM "journal_entries"`;

        const out: ReconciliationFinding[] = [];
        for (const a of accounts) {
          if (toMinorUnits(a.projected) !== toMinorUnits(a.computed)) {
            out.push({
              kind: 'BALANCE_MISMATCH',
              accountId: a.id,
              assetId: a.asset_id,
              projected: a.projected,
              computed: a.computed,
            });
          }
          if (!a.allow_negative && toMinorUnits(a.projected) < 0n) {
            out.push({
              kind: 'NEGATIVE_BALANCE',
              accountId: a.id,
              assetId: a.asset_id,
              balance: a.projected,
            });
          }
        }
        for (const u of unbalanced)
          out.push({
            kind: 'UNBALANCED_ENTRY',
            entryId: u.entry_id,
            assetId: u.asset_id,
            net: u.net,
          });
        for (const t of thin)
          out.push({ kind: 'ENTRY_TOO_FEW_POSTINGS', entryId: t.id, postings: t.n });
        for (const t of trial)
          out.push({ kind: 'TRIAL_BALANCE_NONZERO', assetId: t.asset_id, net: t.net });
        return { findings: out, accountsChecked: accounts.length, entriesChecked: count };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 },
    );

    const status = findings.length === 0 ? 'OK' : 'MISMATCH';
    const run = await this.prisma.ledgerReconciliationRun.create({
      data: {
        trigger,
        status,
        startedAt,
        finishedAt: new Date(),
        accountsChecked,
        entriesChecked,
        findings: findings,
        actorUserId,
      },
    });

    if (status === 'MISMATCH') {
      // Alert routing arrives with monitoring (Phase 7); until then this is an error-level log + audit.
      this.logger.error(
        { runId: run.id, findings: findings.slice(0, 20), total: findings.length },
        'LEDGER_RECONCILIATION_MISMATCH',
      );
    }
    await this.audit.recordSafe({
      action: 'ledger.reconciliation.run',
      outcome: status === 'OK' ? 'SUCCESS' : 'FAILURE',
      actorType: actorUserId ? 'STAFF' : 'SYSTEM',
      actorUserId,
      targetType: 'reconciliation_run',
      targetId: run.id,
      metadata: { trigger, status, findings: findings.length, accountsChecked, entriesChecked },
    });
    return run;
  }

  latest(limit: number): Promise<LedgerReconciliationRun[]> {
    return this.prisma.ledgerReconciliationRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  }
}

/** Runs reconciliation on an interval; a Redis lock ensures one instance runs at a time. */
@Injectable()
export class ReconciliationScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReconciliationScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly reconciliation: ReconciliationService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.config.LEDGER_RECONCILIATION_INTERVAL_SECONDS;
    if (seconds <= 0) return;
    this.timer = setInterval(() => void this.tick(seconds), seconds * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(seconds: number): Promise<void> {
    try {
      const lock = await this.redis.set(
        'lock:ledger-reconciliation',
        '1',
        'PX',
        Math.max(1000, seconds * 1000 - 1000),
        'NX',
      );
      if (lock !== 'OK') return;
      await this.reconciliation.run('SCHEDULED');
    } catch (err) {
      this.logger.error({ err }, 'Scheduled ledger reconciliation failed');
    }
  }
}
