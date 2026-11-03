import { accountLabel } from '../auth/account-label';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, type ApprovalRequest } from '@prisma/client';
import {
  PERMISSIONS,
  type ApprovalAction,
  type ApprovalDto,
  type ApprovalRequestInput,
  type Permission,
} from '@platform/shared';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { LedgerService, type LedgerActor } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PerpsService } from '../perps/perps.service';
import { RbacService } from '../rbac/rbac.service';
import { MarketsService } from '../trading/markets.service';

/** Permission a staff member needs to REQUEST and (a different one) to APPROVE each action. */
export const ACTION_PERMISSION: Record<ApprovalAction, Permission> = {
  'market.resume': PERMISSIONS.MARKETS_CONFIGURE,
  'insurance_fund.seed': PERMISSIONS.MARKETS_CONFIGURE,
  'ledger.reversal': PERMISSIONS.LEDGER_ADJUST,
  'user.reactivate': PERMISSIONS.USERS_MANAGE_STATUS,
  'role.grant': PERMISSIONS.ROLES_ASSIGN,
};

export interface StaffActor {
  userId: string;
  permissions: readonly Permission[];
  requestId?: string | null;
}

function conflict(message: string): AppError {
  return new AppError(HttpStatus.CONFLICT, 'CONFLICT', message);
}

/**
 * Maker-checker (four-eyes) control for sensitive back-office actions
 * (ADR-0012). A request records WHAT will happen and WHY; a DIFFERENT staff
 * member holding the same permission approves it, and only then is it
 * executed. The database refuses an approver equal to the requester and any
 * change to a decided request.
 *
 * Execution is idempotent (ledger keys derived from the request id, upserts),
 * so a retry after a crash between execution and recording cannot apply an
 * action twice. The decision is recorded with a conditional update: only one
 * approver can win.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly markets: MarketsService,
    private readonly perps: PerpsService,
    private readonly ledger: LedgerService,
    private readonly rbac: RbacService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private requirePermission(actor: StaffActor, action: ApprovalAction): void {
    if (!actor.permissions.includes(ACTION_PERMISSION[action])) throw AppError.forbidden();
  }

  async request(input: ApprovalRequestInput, actor: StaffActor): Promise<ApprovalDto> {
    this.requirePermission(actor, input.action);
    if (input.action === 'role.grant' && input.payload.userId === actor.userId)
      throw AppError.forbidden('You cannot request a role for yourself');
    if (input.action === 'user.reactivate' && input.payload.userId === actor.userId)
      throw AppError.forbidden('You cannot reactivate your own account');
    await this.precheck(input);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.approvalRequest.create({
        data: {
          id: randomUUID(),
          action: input.action,
          payload: input.payload,
          reason: input.reason,
          requestedById: actor.userId,
          expiresAt: new Date(Date.now() + this.config.APPROVAL_TTL_HOURS * 3_600_000),
        },
      });
      await this.audit.record(
        {
          action: 'approval.requested',
          outcome: 'SUCCESS',
          actorType: 'STAFF',
          actorUserId: actor.userId,
          targetType: 'approval_request',
          targetId: created.id,
          context: { requestId: actor.requestId ?? null },
          metadata: { action: input.action, payload: input.payload, reason: input.reason },
        },
        tx,
      );
      return created;
    });
    return this.toDto(row);
  }

  /** Validates that the action can run at all, so obviously invalid requests fail early. */
  private async precheck(input: ApprovalRequestInput): Promise<void> {
    switch (input.action) {
      case 'market.resume': {
        const m = await this.markets.require(input.payload.symbol);
        if (m.status === 'ACTIVE') throw conflict('Market is already active');
        return;
      }
      case 'insurance_fund.seed': {
        const a = await this.ledger.requireAsset(input.payload.asset);
        if (!a.isPaper) throw conflict('Insurance fund seeding is only available for paper assets');
        return;
      }
      case 'ledger.reversal': {
        const e = await this.prisma.journalEntry.findUnique({
          where: { id: BigInt(input.payload.entryId) },
        });
        if (!e) throw AppError.notFound('Journal entry not found');
        return;
      }
      case 'user.reactivate': {
        const u = await this.prisma.user.findUnique({ where: { id: input.payload.userId } });
        if (!u) throw AppError.notFound('User not found');
        if (u.status !== 'SUSPENDED') throw conflict('Only suspended accounts can be reactivated');
        return;
      }
      case 'role.grant': {
        const u = await this.prisma.user.findUnique({ where: { id: input.payload.userId } });
        if (!u) throw AppError.notFound('User not found');
        return;
      }
    }
  }

  async list(status: 'pending' | 'all', limit: number): Promise<ApprovalDto[]> {
    await this.expireStale();
    const rows = await this.prisma.approvalRequest.findMany({
      where: status === 'pending' ? { status: 'PENDING' } : {},
      orderBy: { requestedAt: 'desc' },
      take: limit,
      include: {
        requestedBy: { select: { email: true, walletAddress: true } },
        decidedBy: { select: { email: true, walletAddress: true } },
      },
    });
    return rows.map((r) =>
      this.toDto(r, accountLabel(r.requestedBy), r.decidedBy ? accountLabel(r.decidedBy) : null),
    );
  }

  private async expireStale(): Promise<void> {
    await this.prisma.approvalRequest.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: new Date() } },
      data: {
        status: 'EXPIRED',
        decidedAt: new Date(),
        decisionNote: 'Expired without a decision',
      },
    });
  }

  private async pending(id: string): Promise<ApprovalRequest> {
    await this.expireStale();
    const row = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Approval request not found');
    if (row.status !== 'PENDING') throw conflict(`Request is already ${row.status.toLowerCase()}`);
    return row;
  }

  /** Records a decision once; returns false if another staff member decided first. */
  private async decide(
    id: string,
    data: Prisma.ApprovalRequestUncheckedUpdateManyInput,
  ): Promise<boolean> {
    try {
      const r = await this.prisma.approvalRequest.updateMany({
        where: { id, status: 'PENDING' },
        data,
      });
      return r.count === 1;
    } catch (err) {
      // The decided-once trigger fires if a concurrent decision committed first.
      if (err instanceof Prisma.PrismaClientUnknownRequestError) return false;
      if (err instanceof Prisma.PrismaClientKnownRequestError) return false;
      throw err;
    }
  }

  async approve(id: string, actor: StaffActor, note?: string): Promise<ApprovalDto> {
    const row = await this.pending(id);
    const action = row.action as ApprovalAction;
    this.requirePermission(actor, action);
    if (row.requestedById === actor.userId)
      throw AppError.forbidden('A different staff member must approve this request');
    const payload = row.payload as Record<string, string>;
    if (action === 'role.grant' && payload.userId === actor.userId)
      throw AppError.forbidden('You cannot approve a role for yourself');

    const result = await this.execute(row, actor);
    const won = await this.decide(id, {
      status: 'APPROVED',
      decidedById: actor.userId,
      decidedAt: new Date(),
      decisionNote: note ?? null,
      result,
    });
    if (!won) throw conflict('Another staff member decided this request first');
    await this.audit.record({
      action: 'approval.approved',
      outcome: 'SUCCESS',
      actorType: 'STAFF',
      actorUserId: actor.userId,
      targetType: 'approval_request',
      targetId: id,
      context: { requestId: actor.requestId ?? null },
      metadata: { action, payload, result },
    });
    await this.notifications.notify({
      userId: row.requestedById,
      kind: 'approval.decided',
      title: 'Your request was approved',
      body: `${action} was approved and executed.`,
      data: { approvalId: id },
    });
    return this.toDto(await this.prisma.approvalRequest.findUniqueOrThrow({ where: { id } }));
  }

  async reject(id: string, actor: StaffActor, note?: string): Promise<ApprovalDto> {
    const row = await this.pending(id);
    this.requirePermission(actor, row.action as ApprovalAction);
    if (row.requestedById === actor.userId)
      throw AppError.forbidden('Use cancel to withdraw your own request');
    const won = await this.decide(id, {
      status: 'REJECTED',
      decidedById: actor.userId,
      decidedAt: new Date(),
      decisionNote: note ?? null,
    });
    if (!won) throw conflict('Another staff member decided this request first');
    await this.audit.record({
      action: 'approval.rejected',
      outcome: 'SUCCESS',
      actorType: 'STAFF',
      actorUserId: actor.userId,
      targetType: 'approval_request',
      targetId: id,
      context: { requestId: actor.requestId ?? null },
      metadata: { action: row.action, note: note ?? null },
    });
    await this.notifications.notify({
      userId: row.requestedById,
      kind: 'approval.decided',
      title: 'Your request was rejected',
      body: `${row.action} was rejected${note ? `: ${note}` : '.'}`,
      data: { approvalId: id },
    });
    return this.toDto(await this.prisma.approvalRequest.findUniqueOrThrow({ where: { id } }));
  }

  /** The requester withdraws their own pending request. */
  async cancel(id: string, actor: StaffActor): Promise<ApprovalDto> {
    const row = await this.pending(id);
    if (row.requestedById !== actor.userId)
      throw AppError.forbidden('Only the requester can cancel a request');
    // decided_by stays NULL: the four-eyes CHECK only constrains an actual approver.
    const won = await this.decide(id, {
      status: 'CANCELLED',
      decidedAt: new Date(),
      decisionNote: 'Cancelled by requester',
    });
    if (!won) throw conflict('The request was decided in the meantime');
    await this.audit.record({
      action: 'approval.cancelled',
      outcome: 'SUCCESS',
      actorType: 'STAFF',
      actorUserId: actor.userId,
      targetType: 'approval_request',
      targetId: id,
      context: { requestId: actor.requestId ?? null },
    });
    return this.toDto(await this.prisma.approvalRequest.findUniqueOrThrow({ where: { id } }));
  }

  /** Executes an approved action. Every branch is idempotent per request id. */
  private async execute(
    row: ApprovalRequest,
    approver: StaffActor,
  ): Promise<Record<string, string>> {
    const p = row.payload as Record<string, string>;
    const ledgerActor: LedgerActor = {
      actorType: 'STAFF',
      actorUserId: approver.userId,
      requestId: approver.requestId ?? null,
    };
    switch (row.action as ApprovalAction) {
      case 'market.resume': {
        const m = await this.markets.setStatus(p.symbol!, 'ACTIVE', ledgerActor);
        return { symbol: m.symbol, status: m.status };
      }
      case 'insurance_fund.seed': {
        const amount = await this.perps.seedInsuranceFund(
          p.asset!,
          p.amount!,
          ledgerActor,
          `approval:${row.id}`,
        );
        return { asset: p.asset!, amount };
      }
      case 'ledger.reversal': {
        const r = await this.ledger.reverse(
          { entryId: BigInt(p.entryId!), reason: row.reason, idempotencyKey: `approval:${row.id}` },
          ledgerActor,
        );
        return { reversalEntryId: r.entry.id.toString() };
      }
      case 'user.reactivate': {
        await this.prisma.user.updateMany({
          where: { id: p.userId!, status: 'SUSPENDED' },
          data: { status: 'ACTIVE' },
        });
        await this.audit.record({
          action: 'user.reactivated',
          outcome: 'SUCCESS',
          actorType: 'STAFF',
          actorUserId: approver.userId,
          targetType: 'user',
          targetId: p.userId!,
          metadata: { approvalId: row.id, requestedBy: row.requestedById },
        });
        return { userId: p.userId!, status: 'ACTIVE' };
      }
      case 'role.grant': {
        await this.rbac.grantRole({
          userId: p.userId!,
          roleKey: p.role as never,
          grantedById: approver.userId,
          actorType: 'STAFF',
          reason: `Approval ${row.id}: ${row.reason}`,
        });
        return { userId: p.userId!, role: p.role! };
      }
    }
  }

  toDto(r: ApprovalRequest, requestedBy?: string, decidedBy?: string | null): ApprovalDto {
    return {
      id: r.id,
      action: r.action as ApprovalAction,
      payload: r.payload as Record<string, string>,
      reason: r.reason,
      status: r.status.toLowerCase() as ApprovalDto['status'],
      requestedBy: requestedBy ?? r.requestedById,
      requestedAt: r.requestedAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      decidedBy: decidedBy ?? r.decidedById,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote,
      result: (r.result as Record<string, string> | null) ?? null,
    };
  }
}
