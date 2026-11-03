import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  PERMISSION_DESCRIPTIONS,
  ROLES,
  SYSTEM_ROLES,
  type Permission,
  type RoleKey,
} from '@platform/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PrismaService } from '../infrastructure/prisma/prisma.service';

@Injectable()
export class RbacService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RbacService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.syncCatalogue();
  }

  /**
   * Idempotently synchronises the code-defined permission/role catalogue into
   * the database. Permissions removed from code are detached from system roles.
   */
  async syncCatalogue(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const [key, description] of Object.entries(PERMISSION_DESCRIPTIONS)) {
        await tx.permission.upsert({
          where: { key },
          create: { key, description },
          update: { description },
        });
      }
      const permissions = await tx.permission.findMany();
      const idByKey = new Map(permissions.map((p) => [p.key, p.id]));

      for (const role of SYSTEM_ROLES) {
        const saved = await tx.role.upsert({
          where: { key: role.key },
          create: {
            key: role.key,
            name: role.name,
            description: role.description,
            isStaff: role.staff,
          },
          update: { name: role.name, description: role.description, isStaff: role.staff },
        });
        const wanted = role.permissions
          .map((p) => idByKey.get(p))
          .filter((id): id is string => !!id);
        await tx.rolePermission.deleteMany({
          where: { roleId: saved.id, permissionId: { notIn: wanted } },
        });
        await tx.rolePermission.createMany({
          data: wanted.map((permissionId) => ({ roleId: saved.id, permissionId })),
          skipDuplicates: true,
        });
      }
    });
    this.logger.log(`RBAC catalogue synchronised (${SYSTEM_ROLES.length} roles)`);
  }

  async rolesAndPermissionsFor(
    userId: string,
  ): Promise<{ roles: string[]; permissions: Permission[] }> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId },
      select: {
        role: {
          select: { key: true, permissions: { select: { permission: { select: { key: true } } } } },
        },
      },
    });
    const roles = rows.map((r) => r.role.key).sort();
    const permissions = new Set<Permission>();
    for (const row of rows) {
      for (const rp of row.role.permissions) permissions.add(rp.permission.key as Permission);
    }
    return { roles, permissions: [...permissions].sort() };
  }

  /** Assigns the default customer role inside the registration transaction. */
  async assignDefaultRole(userId: string, tx: Prisma.TransactionClient): Promise<void> {
    const role = await tx.role.findUniqueOrThrow({ where: { key: ROLES.USER } });
    await tx.userRole.create({ data: { userId, roleId: role.id } });
  }

  /**
   * Grants a role. `grantedById` is null only for the audited bootstrap CLI.
   * Self-grants are refused to enforce separation of duties.
   */
  async grantRole(params: {
    userId: string;
    roleKey: RoleKey;
    grantedById: string | null;
    actorType: 'STAFF' | 'SYSTEM';
    reason: string;
  }): Promise<void> {
    if (params.grantedById && params.grantedById === params.userId) {
      throw AppError.forbidden('Users cannot grant roles to themselves');
    }
    await this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { key: params.roleKey } });
      if (!role) throw AppError.notFound('Role not found');
      await tx.userRole.upsert({
        where: { userId_roleId: { userId: params.userId, roleId: role.id } },
        create: { userId: params.userId, roleId: role.id, grantedById: params.grantedById },
        update: {},
      });
      await this.audit.record(
        {
          action: 'rbac.role.granted',
          outcome: 'SUCCESS',
          actorType: params.actorType,
          actorUserId: params.grantedById,
          targetType: 'user',
          targetId: params.userId,
          metadata: { role: params.roleKey, reason: params.reason },
        },
        tx,
      );
    });
  }
}
