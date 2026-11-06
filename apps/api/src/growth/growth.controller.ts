import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  feeScheduleSchema,
  type FeeScheduleDto,
  type MyFeesDto,
  type PointsEntryDto,
  type ReferralSummaryDto,
} from '@platform/shared';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { ApiKeyScope, Public, RequirePermissions, RequireStepUp } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { GrowthService } from './growth.service';

const daysQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

/** Fee schedule, referrals and activity points (ADR-0018). */
@ApiTags('growth')
@Controller({ version: '1' })
export class GrowthController {
  constructor(private readonly growth: GrowthService) {}

  @Public()
  @Get('fees/schedule')
  schedule(): Promise<FeeScheduleDto> {
    return this.growth.schedule();
  }

  /** Publishes a new fee schedule (applies at the next tier recomputation and settlement). */
  @Put('admin/fees/schedule')
  @RequireStepUp()
  @RequirePermissions(PERMISSIONS.FEES_CONFIGURE)
  @ApiZodBody(feeScheduleSchema)
  replace(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(feeScheduleSchema)) body: z.infer<typeof feeScheduleSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<FeeScheduleDto> {
    return this.growth.replaceSchedule(body.tiers, auth.user.id, ctx);
  }

  @Get('me/fees')
  @ApiKeyScope('read')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  myFees(@CurrentAuth() auth: AuthContext): Promise<MyFeesDto> {
    return this.growth.myFees(auth.user.id);
  }

  @Get('me/referrals')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  referrals(@CurrentAuth() auth: AuthContext): Promise<ReferralSummaryDto> {
    return this.growth.referrals(auth.user.id);
  }

  @Post('me/referrals/code')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  createCode(
    @CurrentAuth() auth: AuthContext,
    @ReqContext() ctx: RequestContext,
  ): Promise<{ code: string }> {
    return this.growth.createReferralCode(auth.user.id, ctx);
  }

  @Public()
  @Get('points/leaderboard')
  async leaderboard(
    @Query(new ZodValidationPipe(daysQuery)) q: z.infer<typeof daysQuery>,
  ): Promise<{ days: number; entries: PointsEntryDto[]; note: string }> {
    return {
      days: q.days,
      entries: await this.growth.leaderboard(q.days),
      note: 'Points measure real trading activity. They are not a token and carry no promise of one.',
    };
  }

  @Get('me/points')
  @ApiKeyScope('read')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  myPoints(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(daysQuery)) q: z.infer<typeof daysQuery>,
  ) {
    return this.growth.myPoints(auth.user.id, q.days);
  }
}
