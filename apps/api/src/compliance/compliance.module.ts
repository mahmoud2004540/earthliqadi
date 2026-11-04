import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  kycDecisionSchema,
  kycSubmitSchema,
  type KycReviewDto,
  type KycStatusDto,
} from '@platform/shared';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { AuthRateLimit, RequirePermissions, RequireStepUp } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { KycService } from './kyc.service';
import { NotConfiguredScreener, SANCTIONS_SCREENER } from './sanctions';

const idParam = z.object({ id: z.uuid() });
const queueQuery = z.object({
  status: z.enum(['pending', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@ApiTags('compliance')
@Controller({ path: 'me/verification', version: '1' })
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  status(@CurrentAuth() auth: AuthContext): Promise<KycStatusDto> {
    return this.kyc.status(auth.user.id);
  }

  @Post()
  @AuthRateLimit()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  @ApiZodBody(kycSubmitSchema)
  submit(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(kycSubmitSchema)) body: z.infer<typeof kycSubmitSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<KycStatusDto> {
    return this.kyc.submit(auth.user.id, body, ctx);
  }
}

@ApiTags('admin')
@Controller({ path: 'admin/kyc', version: '1' })
export class KycReviewController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.KYC_REVIEW)
  async queue(
    @Query(new ZodValidationPipe(queueQuery)) q: z.infer<typeof queueQuery>,
  ): Promise<{ cases: KycReviewDto[] }> {
    return { cases: await this.kyc.queue(q.status, q.limit) };
  }

  /** Decrypts the profile; every view is audited. */
  @Get(':id')
  @RequirePermissions(PERMISSIONS.KYC_REVIEW)
  case(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(idParam)) p: z.infer<typeof idParam>,
    @ReqContext() ctx: RequestContext,
  ): Promise<KycReviewDto> {
    return this.kyc.reviewCase(p.id, auth.user.id, ctx);
  }

  @Post(':id/decision')
  @HttpCode(HttpStatus.OK)
  @RequireStepUp()
  @RequirePermissions(PERMISSIONS.KYC_REVIEW)
  @ApiZodBody(kycDecisionSchema)
  decide(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(idParam)) p: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(kycDecisionSchema)) body: z.infer<typeof kycDecisionSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<KycReviewDto> {
    return this.kyc.decide(p.id, auth.user.id, body.decision, body.note, ctx);
  }
}

@Module({
  controllers: [KycController, KycReviewController],
  providers: [KycService, { provide: SANCTIONS_SCREENER, useClass: NotConfiguredScreener }],
  exports: [KycService],
})
export class ComplianceModule {}
