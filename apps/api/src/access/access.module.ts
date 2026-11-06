import {
  Body,
  Controller,
  Get,
  Global,
  HttpCode,
  HttpStatus,
  Module,
  type MiddlewareConsumer,
  type NestModule,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  acceptTermsSchema,
  type AccessStatusDto,
  type MyAccessStatusDto,
} from '@platform/shared';
import type { Request } from 'express';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { ApiKeyScope, Public, RequirePermissions } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AccessPolicyGuard } from './access.guard';
import { AccessService } from './access.service';
import { RegionBlockMiddleware } from './region-block.middleware';
import { SanctionsSyncService } from './sanctions-sync.service';

@ApiTags('access')
@Controller({ version: '1' })
export class AccessController {
  constructor(private readonly access: AccessService) {}

  /** Region status for this request and the current terms version. */
  @Public()
  @Get('access')
  status(@Req() req: Request): AccessStatusDto {
    return this.access.status(this.access.locationOf(req));
  }

  @Get('me/access')
  @ApiKeyScope('read')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  mine(@CurrentAuth() auth: AuthContext, @Req() req: Request): Promise<MyAccessStatusDto> {
    return this.access.myStatus(auth.user.id, this.access.locationOf(req));
  }

  @Post('me/terms/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  @ApiZodBody(acceptTermsSchema)
  accept(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(acceptTermsSchema)) body: z.infer<typeof acceptTermsSchema>,
    @Req() req: Request,
    @ReqContext() ctx: RequestContext,
  ): Promise<MyAccessStatusDto> {
    return this.access.acceptTerms(auth.user.id, body.version, this.access.locationOf(req), ctx);
  }
}

@Global()
@Module({
  controllers: [AccessController],
  providers: [AccessService, AccessPolicyGuard, SanctionsSyncService],
  exports: [AccessService, AccessPolicyGuard, SanctionsSyncService],
})
export class AccessModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RegionBlockMiddleware).forRoutes('*');
  }
}
