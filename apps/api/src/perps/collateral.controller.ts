import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  collateralAssetConfigSchema,
  type CollateralAssetDto,
} from '@platform/shared';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { RequirePermissions, RequireStepUp } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CollateralService } from './collateral.service';

/** Staff: which assets count as collateral, and their haircuts (ADR-0027). */
@ApiTags('admin')
@Controller({ path: 'admin/collateral-assets', version: '1' })
export class AdminCollateralController {
  constructor(private readonly collateral: CollateralService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequireStepUp()
  @RequirePermissions(PERMISSIONS.MARKETS_CONFIGURE)
  @ApiZodBody(collateralAssetConfigSchema)
  configure(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(collateralAssetConfigSchema))
    body: z.infer<typeof collateralAssetConfigSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<CollateralAssetDto> {
    return this.collateral.configure(auth.user.id, body, ctx);
  }
}
