import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  addMarginSchema,
  leverageSchema,
  marketSymbolSchema,
  type FundingRoundDto,
  type PerpStatsDto,
  type PositionDto,
} from '@platform/shared';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { Public, RequirePermissions } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PerpsService } from './perps.service';

const symbolParam = z.object({ symbol: marketSymbolSchema });
const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/** Perpetual futures (paper only; ADR-0011). */
@ApiTags('perpetuals')
@Controller({ path: 'perp', version: '1' })
export class PerpsController {
  constructor(private readonly perps: PerpsService) {}

  /** Mark, index and funding for a perpetual market. */
  @Public()
  @Get('markets/:symbol/stats')
  stats(
    @Param(new ZodValidationPipe(symbolParam)) p: z.infer<typeof symbolParam>,
  ): Promise<PerpStatsDto> {
    return this.perps.stats(p.symbol);
  }

  @Public()
  @Get('markets/:symbol/funding')
  async funding(
    @Param(new ZodValidationPipe(symbolParam)) p: z.infer<typeof symbolParam>,
    @Query(new ZodValidationPipe(limitQuery)) q: z.infer<typeof limitQuery>,
  ): Promise<{ rounds: FundingRoundDto[] }> {
    return { rounds: await this.perps.fundingHistory(p.symbol, q.limit) };
  }

  /** Insurance fund balances (paper). Published for transparency. */
  @Public()
  @Get('insurance-fund')
  async insurance(): Promise<{ funds: { asset: string; balance: string }[] }> {
    return { funds: await this.perps.insuranceFunds() };
  }

  @Get('positions')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  async positions(@CurrentAuth() auth: AuthContext): Promise<{ positions: PositionDto[] }> {
    return { positions: await this.perps.positions(auth.user.id) };
  }

  @Post('leverage')
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  @ApiZodBody(leverageSchema)
  leverage(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(leverageSchema)) body: z.infer<typeof leverageSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<PositionDto> {
    return this.perps.setLeverage(auth.user.id, body.market, body.leverage, {
      actorType: 'USER',
      actorUserId: auth.user.id,
      requestId: ctx.requestId,
    });
  }

  @Post('margin')
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  @ApiZodBody(addMarginSchema)
  addMargin(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(addMarginSchema)) body: z.infer<typeof addMarginSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<PositionDto> {
    return this.perps.addMargin(auth.user.id, body.market, body.amount, {
      actorType: 'USER',
      actorUserId: auth.user.id,
      requestId: ctx.requestId,
    });
  }
}
