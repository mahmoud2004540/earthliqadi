import { Injectable } from '@nestjs/common';
import type { SystemHealthDto } from '@platform/shared';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { parsePerpConfig } from '../perps/perp-config';
import { markMaxAgeMs } from '../perps/perp-prices';
import { PerpsService } from '../perps/perps.service';

/** Operational snapshot shared by the admin console and the metrics endpoint. */
@Injectable()
export class HealthReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perps: PerpsService,
  ) {}

  async report(now = new Date()): Promise<SystemHealthDto> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        symbol: string;
        kind: string;
        status: string;
        perp_config: unknown;
        enqueued: bigint;
        processed: bigint | null;
        emitted: bigint | null;
        settled: bigint | null;
        last_sample: Date | null;
      }[]
    >`
      SELECT m."id", m."symbol", m."kind"::text AS "kind", m."status"::text AS "status", m."perp_config",
             m."next_command_seq" AS "enqueued", e."last_command_seq" AS "processed",
             e."last_event_seq" AS "emitted", s."last_event_seq" AS "settled",
             (SELECT max(p."sampled_at") FROM "perp_price_samples" p WHERE p."market_id" = m."id") AS "last_sample"
        FROM "markets" m
        LEFT JOIN "engine_market_state" e ON e."market_id" = m."id"
        LEFT JOIN "settlement_state" s ON s."market_id" = m."id"
       ORDER BY m."symbol"`;
    const [recon, approvalsPending, kycPending, ticketsOpen, liquidating] = await Promise.all([
      this.prisma.ledgerReconciliationRun.findFirst({ orderBy: { startedAt: 'desc' } }),
      this.prisma.approvalRequest.count({
        where: { status: 'PENDING', expiresAt: { gte: now } },
      }),
      this.prisma.kycCase.count({ where: { status: 'PENDING' } }),
      this.prisma.supportTicket.count({ where: { status: { not: 'CLOSED' } } }),
      this.prisma.position.count({ where: { status: 'LIQUIDATING' } }),
    ]);
    return {
      generatedAt: now.toISOString(),
      markets: rows.map((r) => {
        const perp = r.kind === 'PERPETUAL';
        let indexStale: boolean | null = null;
        if (perp) {
          const maxAge = markMaxAgeMs(parsePerpConfig(r.perp_config as never));
          indexStale = !r.last_sample || now.getTime() - r.last_sample.getTime() > maxAge;
        }
        return {
          symbol: r.symbol,
          kind: perp ? 'perpetual' : 'spot',
          status: r.status,
          engineBacklog: (r.enqueued - (r.processed ?? 0n)).toString(),
          settlementLag: ((r.emitted ?? 0n) - (r.settled ?? 0n)).toString(),
          indexStale,
        };
      }),
      reconciliation: recon
        ? {
            status: recon.status,
            startedAt: recon.startedAt.toISOString(),
            findings: Array.isArray(recon.findings) ? recon.findings.length : 0,
          }
        : null,
      insuranceFunds: await this.perps.insuranceFunds(),
      queues: { approvalsPending, kycPending, ticketsOpen },
      positionsLiquidating: liquidating,
    };
  }
}
