import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  approvalDecisionSchema,
  approvalRequestSchema,
  suspendUserSchema,
  type ApprovalDto,
  type SystemHealthDto,
} from '@platform/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { SessionService } from '../auth/session.service';
import { AppError } from '../common/app-error';
import { RequirePermissions } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { PerpsService } from '../perps/perps.service';
import { ApprovalsService, type StaffActor } from './approvals.service';
import { HealthReportService } from './health-report.service';

const idParam = z.object({ id: z.uuid() });
const listQuery = z.object({
  status: z.enum(['pending', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function staff(auth: AuthContext, ctx: RequestContext): StaffActor {
  return { userId: auth.user.id, permissions: auth.permissions, requestId: ctx.requestId };
}

/** Maker-checker requests (ADR-0012). The service enforces per-action permissions. */
@ApiTags('admin')
@Controller({ path: 'admin/approvals', version: '1' })
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.APPROVALS_READ)
  async list(
    @Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>,
  ): Promise<{ requests: ApprovalDto[] }> {
    return { requests: await this.approvals.list(q.status, q.limit) };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.APPROVALS_READ)
  @ApiZodBody(approvalRequestSchema)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(approvalRequestSchema)) body: z.infer<typeof approvalRequestSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<ApprovalDto> {
    return this.approvals.request(body, staff(auth, ctx));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.APPROVALS_READ)
  @ApiZodBody(approvalDecisionSchema)
  approve(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(idParam)) p: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(approvalDecisionSchema))
    body: z.infer<typeof approvalDecisionSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<ApprovalDto> {
    return this.approvals.approve(p.id, staff(auth, ctx), body.note);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.APPROVALS_READ)
  @ApiZodBody(approvalDecisionSchema)
  reject(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(idParam)) p: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(approvalDecisionSchema))
    body: z.infer<typeof approvalDecisionSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<ApprovalDto> {
    return this.approvals.reject(p.id, staff(auth, ctx), body.note);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.APPROVALS_READ)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(idParam)) p: z.infer<typeof idParam>,
    @ReqContext() ctx: RequestContext,
  ): Promise<ApprovalDto> {
    return this.approvals.cancel(p.id, staff(auth, ctx));
  }
}

/** Single-person emergency controls and back-office views. */
@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
export class AdminOperationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly perps: PerpsService,
    private readonly health: HealthReportService,
  ) {}

  /**
   * Suspends an account immediately and revokes all its sessions (protective,
   * single person). Reactivation needs maker-checker approval.
   */
  @Post('users/:id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.USERS_MANAGE_STATUS)
  @ApiZodBody(suspendUserSchema)
  async suspend(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(idParam)) p: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(suspendUserSchema)) body: z.infer<typeof suspendUserSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<{ id: string; status: string; sessionsRevoked: number }> {
    if (p.id === auth.user.id) throw AppError.forbidden('You cannot suspend your own account');
    const revoked = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: p.id } });
      if (!user) throw AppError.notFound('User not found');
      await tx.user.update({ where: { id: p.id }, data: { status: 'SUSPENDED' } });
      const n = await this.sessions.revokeAllForUser(p.id, 'suspended', { tx });
      await this.audit.record(
        {
          action: 'user.suspended',
          outcome: 'SUCCESS',
          actorType: 'STAFF',
          actorUserId: auth.user.id,
          targetType: 'user',
          targetId: p.id,
          context: ctx,
          metadata: { reason: body.reason, from: user.status, sessionsRevoked: n },
        },
        tx,
      );
      return n;
    });
    return { id: p.id, status: 'SUSPENDED', sessionsRevoked: revoked };
  }

  /** User detail for staff: profile, roles, balances, positions, KYC. Access is audited. */
  @Get('users/:id')
  @RequirePermissions(PERMISSIONS.USERS_READ)
  async user(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(idParam)) p: z.infer<typeof idParam>,
    @ReqContext() ctx: RequestContext,
  ) {
    const u = await this.prisma.user.findUnique({
      where: { id: p.id },
      select: {
        id: true,
        email: true,
        status: true,
        accountType: true,
        emailVerifiedAt: true,
        mfaEnabledAt: true,
        kycLevel: true,
        createdAt: true,
        roles: { select: { role: { select: { key: true } } } },
        _count: { select: { sessions: { where: { revokedAt: null } } } },
      },
    });
    if (!u) throw AppError.notFound('User not found');
    await this.audit.record({
      action: 'admin.user.viewed',
      outcome: 'SUCCESS',
      actorType: 'STAFF',
      actorUserId: auth.user.id,
      targetType: 'user',
      targetId: u.id,
      context: ctx,
    });
    return {
      id: u.id,
      email: u.email,
      status: u.status,
      accountType: u.accountType,
      emailVerified: u.emailVerifiedAt !== null,
      mfaEnabled: u.mfaEnabledAt !== null,
      kycLevel: u.kycLevel,
      roles: u.roles.map((r) => r.role.key),
      activeSessions: u._count.sessions,
      createdAt: u.createdAt.toISOString(),
      balances: await this.ledger.balancesForUser(u.id),
      positions: (await this.perps.positions(u.id)).filter((x) => x.side !== 'flat'),
    };
  }

  /** One-page operational overview for the admin console. */
  @Get('health')
  @RequirePermissions(PERMISSIONS.REPORTS_READ)
  overview(): Promise<SystemHealthDto> {
    return this.health.report();
  }
}
