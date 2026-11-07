import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Incident, IncidentUpdate } from '@prisma/client';
import type {
  IncidentDto,
  StatusComponentDto,
  StatusDto,
  createIncidentSchema,
  incidentUpdateSchema,
} from '@platform/shared';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { OFAC_SOURCE } from '../access/ofac';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { MarketDataService } from '../market-data/market-data.service';
import { freshness, overallState, tradingState } from './status-rules';

const CHAIN_MAX_AGE_MS = 10 * 60_000;
const RESOLVED_WINDOW_MS = 90 * 24 * 3_600_000;

/**
 * Public status page (ADR-0030): component states derived from live signals,
 * plus incident reports written by staff. Nothing here is self-reported as
 * fine: a missing signal shows as degraded.
 */
@Injectable()
export class StatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async components(now: Date): Promise<StatusComponentDto[]> {
    const out: StatusComponentDto[] = [];
    const markets = await this.prisma.market.findMany({
      where: { status: { in: ['ACTIVE', 'HALTED'] }, isPaper: false },
      select: { id: true, status: true },
    });
    const states: ('live' | 'delayed' | 'halted')[] = [];
    for (const m of markets) states.push((await this.marketData.status(this.prisma, m)).state);
    out.push({ key: 'trading', ...tradingState(states), lastSeen: now.toISOString() });

    const committed = await this.prisma.vaultState.findFirst({
      where: { status: 'COMMITTED' },
      orderBy: { committedAt: 'desc' },
      select: { index: true, committedAt: true },
    });
    const interval = this.config.VAULT_STATE_INTERVAL_SECONDS;
    if (committed || interval > 0) {
      const at = committed?.committedAt ?? null;
      out.push({
        key: 'vault',
        state: interval > 0 ? freshness(at, 2 * interval * 1000 + 60_000, now) : 'operational',
        detail: committed
          ? `Balance root #${committed.index.toString()} committed on-chain`
          : 'No balance root committed yet',
        lastSeen: at?.toISOString() ?? null,
      });
    }

    const cursor = await this.prisma.chainCursor.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (cursor) {
      out.push({
        key: 'chain',
        state: freshness(cursor.updatedAt, CHAIN_MAX_AGE_MS, now),
        detail: `Deposits and withdrawals indexed to block ${cursor.lastBlock.toString()}`,
        lastSeen: cursor.updatedAt.toISOString(),
      });
    }

    const hours = this.config.SANCTIONS_SYNC_HOURS;
    if (hours > 0) {
      const last = await this.prisma.auditLog.findFirst({
        where: { action: 'access.sanctions.list_replaced', targetId: OFAC_SOURCE },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      });
      const at = last?.occurredAt ?? null;
      out.push({
        key: 'sanctions',
        state: freshness(at, 2 * hours * 3_600_000, now),
        detail: at ? 'Sanctions list updated' : 'Sanctions list not synced yet',
        lastSeen: at?.toISOString() ?? null,
      });
    }
    return out;
  }

  private toDto(i: Incident & { updates: IncidentUpdate[] }): IncidentDto {
    return {
      id: i.id,
      title: i.title,
      impact: i.impact as IncidentDto['impact'],
      status: i.status as IncidentDto['status'],
      startedAt: i.startedAt.toISOString(),
      resolvedAt: i.resolvedAt?.toISOString() ?? null,
      updates: [...i.updates]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((u) => ({
          status: u.status as IncidentDto['status'],
          body: u.body,
          at: u.createdAt.toISOString(),
        })),
    };
  }

  async status(now = new Date()): Promise<StatusDto> {
    const components = await this.components(now);
    const incidents = await this.prisma.incident.findMany({
      where: {
        OR: [
          { resolvedAt: null },
          { resolvedAt: { gte: new Date(now.getTime() - RESOLVED_WINDOW_MS) } },
        ],
      },
      include: { updates: true },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
    const dtos = incidents
      .map((i) => this.toDto(i))
      .sort((a, b) => Number(a.resolvedAt !== null) - Number(b.resolvedAt !== null));
    return {
      generatedAt: now.toISOString(),
      overall: overallState(
        components.map((c) => c.state),
        dtos.filter((d) => d.resolvedAt === null).map((d) => d.impact),
      ),
      components,
      incidents: dtos,
    };
  }

  async create(
    staffId: string,
    input: z.infer<typeof createIncidentSchema>,
    ctx: RequestContext,
  ): Promise<IncidentDto> {
    const id = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.incident.create({
        data: {
          id,
          title: input.title,
          impact: input.impact,
          status: 'investigating',
          createdBy: staffId,
        },
      });
      await tx.incidentUpdate.create({
        data: {
          id: randomUUID(),
          incidentId: id,
          status: 'investigating',
          body: input.body,
          createdBy: staffId,
        },
      });
      await this.audit.record(
        {
          action: 'status.incident.opened',
          outcome: 'SUCCESS',
          actorType: 'STAFF',
          actorUserId: staffId,
          targetType: 'incident',
          targetId: id,
          context: ctx,
          metadata: { title: input.title, impact: input.impact },
        },
        tx,
      );
    });
    return this.get(id);
  }

  async addUpdate(
    staffId: string,
    id: string,
    input: z.infer<typeof incidentUpdateSchema>,
    ctx: RequestContext,
  ): Promise<IncidentDto> {
    const i = await this.prisma.incident.findUnique({ where: { id } });
    if (!i) throw AppError.notFound('Incident not found');
    if (i.status === 'resolved')
      throw new AppError(
        HttpStatus.CONFLICT,
        'CONFLICT',
        'The incident is resolved; open a new one',
      );
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.incidentUpdate.create({
        data: {
          id: randomUUID(),
          incidentId: id,
          status: input.status,
          body: input.body,
          createdBy: staffId,
        },
      });
      await tx.incident.update({
        where: { id },
        data: { status: input.status, resolvedAt: input.status === 'resolved' ? now : null },
      });
      await this.audit.record(
        {
          action: 'status.incident.updated',
          outcome: 'SUCCESS',
          actorType: 'STAFF',
          actorUserId: staffId,
          targetType: 'incident',
          targetId: id,
          context: ctx,
          metadata: { status: input.status },
        },
        tx,
      );
    });
    return this.get(id);
  }

  private async get(id: string): Promise<IncidentDto> {
    const i = await this.prisma.incident.findUniqueOrThrow({
      where: { id },
      include: { updates: true },
    });
    return this.toDto(i);
  }
}
