import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  changePasswordSchema,
  PERMISSIONS,
  totpDisableSchema,
  totpEnableSchema,
  totpSetupSchema,
  uuidParamSchema,
  type CurrentUserDto,
  type SessionDto,
} from '@platform/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { AuthService } from '../auth/auth.service';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { MfaService } from '../auth/mfa.service';
import { SessionService } from '../auth/session.service';
import { toCurrentUserDto } from '../auth/user-dto';
import { AppError } from '../common/app-error';
import { AuthRateLimit, RequirePermissions } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/** Self-service account endpoints. Every query is scoped to the authenticated user. */
@ApiTags('account')
@Controller({ path: 'me', version: '1' })
export class AccountController {
  constructor(
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  me(@CurrentAuth() auth: AuthContext): CurrentUserDto {
    return toCurrentUserDto(auth.user, auth.roles, auth.permissions);
  }

  @Get('sessions')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  async listSessions(@CurrentAuth() auth: AuthContext): Promise<{ sessions: SessionDto[] }> {
    const sessions = await this.sessions.listActive(auth.user.id);
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        current: s.id === auth.sessionId,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
      })),
    };
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  async revokeSession(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) params: z.infer<typeof uuidParamSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<void> {
    const revoked = await this.sessions.revokeOwned(auth.user.id, params.id, 'revoked_by_user');
    if (!revoked) throw AppError.notFound('Session not found');
    await this.audit.record({
      action: 'session.revoked',
      outcome: 'SUCCESS',
      actorType: 'USER',
      actorUserId: auth.user.id,
      targetType: 'session',
      targetId: params.id,
      context: ctx,
    });
  }

  @Post('sessions/revoke-others')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  async revokeOtherSessions(
    @CurrentAuth() auth: AuthContext,
    @ReqContext() ctx: RequestContext,
  ): Promise<{ revoked: number }> {
    const revoked = await this.sessions.revokeAllForUser(auth.user.id, 'revoked_by_user', {
      exceptSessionId: auth.sessionId,
    });
    await this.audit.record({
      action: 'session.revoked_others',
      outcome: 'SUCCESS',
      actorType: 'USER',
      actorUserId: auth.user.id,
      context: ctx,
      metadata: { revoked },
    });
    return { revoked };
  }

  @Post('password')
  @AuthRateLimit()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiZodBody(changePasswordSchema)
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  async changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<void> {
    await this.auth.changePassword(
      { userId: auth.user.id, sessionId: auth.sessionId, ...body },
      ctx,
    );
  }

  @Post('mfa/totp/setup')
  @AuthRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(totpSetupSchema)
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  async beginTotpSetup(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(totpSetupSchema)) body: z.infer<typeof totpSetupSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<{ otpauthUri: string; secret: string }> {
    return this.mfa.beginSetup(auth.user.id, body.password, ctx);
  }

  @Post('mfa/totp/enable')
  @AuthRateLimit()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiZodBody(totpEnableSchema)
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  async enableTotp(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(totpEnableSchema)) body: z.infer<typeof totpEnableSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<void> {
    await this.mfa.confirmSetup(auth.user.id, body.code, ctx);
  }

  @Post('mfa/totp/disable')
  @AuthRateLimit()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiZodBody(totpDisableSchema)
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  async disableTotp(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(totpDisableSchema)) body: z.infer<typeof totpDisableSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<void> {
    await this.mfa.disable({ userId: auth.user.id, sessionId: auth.sessionId, ...body }, ctx);
  }
}
