import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  apiKeyCreateSchema,
  apiKeyRequestSchema,
  uuidParamSchema,
  type ApiKeyChallengeDto,
  type ApiKeyDto,
} from '@platform/shared';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { RequirePermissions } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ApiKeysService } from './api-keys.service';

/**
 * Agent API key management (ADR-0017). Session only: none of these routes
 * accept API-key authentication, so a key can never create or extend keys.
 */
@ApiTags('api-keys')
@Controller({ path: 'me/api-keys', version: '1' })
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  async list(@CurrentAuth() auth: AuthContext): Promise<{ keys: ApiKeyDto[] }> {
    return { keys: await this.keys.list(auth.user.id) };
  }

  /** Returns the message to sign with the wallet. Nothing is stored until it is signed. */
  @Post('challenge')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  @ApiZodBody(apiKeyRequestSchema)
  challenge(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(apiKeyRequestSchema)) body: z.infer<typeof apiKeyRequestSchema>,
  ): Promise<ApiKeyChallengeDto> {
    return this.keys.challenge(auth, body);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  @ApiZodBody(apiKeyCreateSchema)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(apiKeyCreateSchema)) body: z.infer<typeof apiKeyCreateSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<ApiKeyDto> {
    return this.keys.create(auth, body, ctx);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  revoke(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) p: z.infer<typeof uuidParamSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<ApiKeyDto> {
    return this.keys.revoke(auth.user.id, p.id, ctx);
  }
}
