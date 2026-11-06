import { AccessPolicy } from '../access/access.guard';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  algoOrderSchema,
  rfqAcceptSchema,
  rfqMakerSchema,
  rfqQuoteSchema,
  rfqRequestSchema,
  uuidParamSchema,
  type AlgoOrderDto,
  type RfqDto,
} from '@platform/shared';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { ApiKeyScope, RequirePermissions, RequireStepUp } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TradingModule } from '../trading/trading.module';
import { AlgoOrdersScheduler, AlgoOrdersService } from './algo-orders.service';
import { RfqService } from './rfq.service';

/** TWAP and iceberg orders (ADR-0020). */
@ApiTags('trading')
@Controller({ path: 'algo-orders', version: '1' })
export class AlgoOrdersController {
  constructor(private readonly algos: AlgoOrdersService) {}

  @Get()
  @ApiKeyScope('read')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  async list(@CurrentAuth() auth: AuthContext): Promise<{ algoOrders: AlgoOrderDto[] }> {
    return { algoOrders: await this.algos.list(auth.user.id) };
  }

  @Post()
  @AccessPolicy('open', 'single')
  @ApiKeyScope('trade')
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  @ApiZodBody(algoOrderSchema)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(algoOrderSchema)) body: z.infer<typeof algoOrderSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<AlgoOrderDto> {
    return this.algos.create(auth.user.id, body, ctx);
  }

  @Delete(':id')
  @ApiKeyScope('trade')
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) p: z.infer<typeof uuidParamSchema>,
  ): Promise<AlgoOrderDto> {
    return this.algos.cancel(auth.user.id, p.id);
  }
}

/** Request for quote and block trades (ADR-0020). */
@ApiTags('trading')
@Controller({ path: 'rfq', version: '1' })
export class RfqController {
  constructor(private readonly rfq: RfqService) {}

  @Post()
  @AccessPolicy('open')
  @ApiKeyScope('trade')
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  @ApiZodBody(rfqRequestSchema)
  request(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(rfqRequestSchema)) body: z.infer<typeof rfqRequestSchema>,
  ): Promise<RfqDto> {
    return this.rfq.request(auth.user.id, body);
  }

  /** Registered makers: open requests to quote. */
  @Get('open')
  @ApiKeyScope('read')
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  async open(@CurrentAuth() auth: AuthContext): Promise<{ requests: RfqDto[] }> {
    return { requests: await this.rfq.open(auth.user.id) };
  }

  @Get(':id')
  @ApiKeyScope('read')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  get(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) p: z.infer<typeof uuidParamSchema>,
  ): Promise<RfqDto> {
    return this.rfq.get(auth.user.id, p.id);
  }

  @Post(':id/quotes')
  @AccessPolicy('open')
  @ApiKeyScope('trade')
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  @ApiZodBody(rfqQuoteSchema)
  quote(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) p: z.infer<typeof uuidParamSchema>,
    @Body(new ZodValidationPipe(rfqQuoteSchema)) body: z.infer<typeof rfqQuoteSchema>,
  ) {
    return this.rfq.quote(auth.user.id, p.id, body.price);
  }

  @Post(':id/accept')
  @AccessPolicy('open')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiKeyScope('trade')
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  @ApiZodBody(rfqAcceptSchema)
  accept(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) p: z.infer<typeof uuidParamSchema>,
    @Body(new ZodValidationPipe(rfqAcceptSchema)) body: z.infer<typeof rfqAcceptSchema>,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.rfq.accept(auth.user.id, p.id, body.quoteId, ctx);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('trade')
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) p: z.infer<typeof uuidParamSchema>,
  ): Promise<RfqDto> {
    return this.rfq.cancel(auth.user.id, p.id);
  }
}

/** Staff: register an RFQ maker (public, rule-based programme). */
@ApiTags('admin')
@Controller({ path: 'admin/rfq-makers', version: '1' })
export class AdminRfqController {
  constructor(private readonly rfq: RfqService) {}

  @Post()
  @RequireStepUp()
  @RequirePermissions(PERMISSIONS.MARKETS_CONFIGURE)
  @ApiZodBody(rfqMakerSchema)
  async register(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(rfqMakerSchema)) body: z.infer<typeof rfqMakerSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<{ userId: string; registered: true }> {
    await this.rfq.registerMaker(auth.user.id, body.userId, ctx);
    return { userId: body.userId, registered: true };
  }
}

@Module({
  imports: [TradingModule],
  controllers: [AlgoOrdersController, RfqController, AdminRfqController],
  providers: [AlgoOrdersService, AlgoOrdersScheduler, RfqService],
  exports: [AlgoOrdersService],
})
export class AlgoOrdersModule {}
