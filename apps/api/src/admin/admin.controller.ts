import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@platform/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { RequirePermissions } from '../common/decorators';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../infrastructure/prisma/prisma.service';

const userListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});

const auditListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Return entries with id lower than this (descending pagination). */
  before: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  action: z.string().max(96).optional(),
});

/**
 * Back-office read endpoints (Phase 1 RBAC foundation). Responses never
 * include password hashes, MFA secrets or session tokens. Data access by staff
 * is itself audited.
 */
@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('users')
  @RequirePermissions(PERMISSIONS.USERS_READ)
  async listUsers(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(userListQuery)) query: z.infer<typeof userListQuery>,
    @ReqContext() ctx: RequestContext,
  ) {
    const users = await this.prisma.user.findMany({
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        email: true,
        status: true,
        accountType: true,
        emailVerifiedAt: true,
        mfaEnabledAt: true,
        createdAt: true,
        roles: { select: { role: { select: { key: true } } } },
      },
    });
    const page = users.slice(0, query.limit);
    await this.audit.record({
      action: 'admin.users.list',
      outcome: 'SUCCESS',
      actorType: 'STAFF',
      actorUserId: auth.user.id,
      context: ctx,
      metadata: { count: page.length },
    });
    return {
      users: page.map((u) => ({
        id: u.id,
        email: u.email,
        status: u.status,
        accountType: u.accountType,
        emailVerified: u.emailVerifiedAt !== null,
        mfaEnabled: u.mfaEnabledAt !== null,
        roles: u.roles.map((r) => r.role.key),
        createdAt: u.createdAt.toISOString(),
      })),
      nextCursor: users.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  @Get('audit-logs')
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  async listAuditLogs(
    @Query(new ZodValidationPipe(auditListQuery)) query: z.infer<typeof auditListQuery>,
  ) {
    const entries = await this.prisma.auditLog.findMany({
      where: {
        ...(query.before ? { id: { lt: BigInt(query.before) } } : {}),
        ...(query.action ? { action: query.action } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit,
    });
    return {
      entries: entries.map((e) => ({
        ...e,
        id: e.id.toString(),
        occurredAt: e.occurredAt.toISOString(),
      })),
      nextBefore:
        entries.length === query.limit
          ? (entries[entries.length - 1]?.id.toString() ?? null)
          : null,
    };
  }
}
