import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  createMarketSchema,
  marketStatusSchema,
  marketSymbolSchema,
  orderListQuerySchema,
  placeOrderSchema,
  reduceOrderSchema,
  type MarketDto,
  type OrderDto,
  type TradeDto,
} from '@platform/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { Public, RequirePermissions, RequireStepUp } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { MarketsService } from './markets.service';
import { OrdersService } from './orders.service';

const orderIdParam = z.object({ id: z.uuid() });
const symbolParam = z.object({ symbol: marketSymbolSchema });
const tradesQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

@ApiTags('trading')
@Controller({ path: 'markets', version: '1' })
export class MarketsController {
  constructor(private readonly markets: MarketsService) {}

  /** Market definitions only. No prices, volumes or depth (market data is Phase 4). */
  @Public()
  @Get()
  async list(): Promise<{ markets: MarketDto[] }> {
    return { markets: (await this.markets.list()).map((m) => this.markets.toDto(m)) };
  }
}

@ApiTags('trading')
@Controller({ path: 'orders', version: '1' })
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** 202: the order is funded and queued; the engine decides acceptance asynchronously. */
  @Post()
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  @ApiZodBody(placeOrderSchema)
  async place(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(placeOrderSchema)) body: z.infer<typeof placeOrderSchema>,
    @ReqContext() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    const { order, replayed } = await this.orders.place(auth.user.id, body, ctx);
    res.status(replayed ? HttpStatus.OK : HttpStatus.ACCEPTED);
    return order;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(orderListQuerySchema)) query: z.infer<typeof orderListQuerySchema>,
  ): Promise<{ orders: OrderDto[] }> {
    return { orders: await this.orders.list(auth.user.id, query) };
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  get(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(orderIdParam)) params: z.infer<typeof orderIdParam>,
  ): Promise<OrderDto> {
    return this.orders.get(auth.user.id, params.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(orderIdParam)) params: z.infer<typeof orderIdParam>,
  ): Promise<OrderDto> {
    return this.orders.cancel(auth.user.id, params.id);
  }

  /** Reduce the remaining quantity (keeps time priority). Price changes = cancel and re-place. */
  @Patch(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  @ApiZodBody(reduceOrderSchema)
  reduce(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(orderIdParam)) params: z.infer<typeof orderIdParam>,
    @Body(new ZodValidationPipe(reduceOrderSchema)) body: z.infer<typeof reduceOrderSchema>,
  ): Promise<OrderDto> {
    return this.orders.reduce(auth.user.id, params.id, body.remainingQuantity);
  }
}

@ApiTags('trading')
@Controller({ path: 'me', version: '1' })
export class MyTradesController {
  constructor(private readonly orders: OrdersService) {}

  @Get('trades')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  async trades(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(tradesQuery)) query: z.infer<typeof tradesQuery>,
  ): Promise<{ trades: TradeDto[] }> {
    return { trades: await this.orders.trades(auth.user.id, query.limit) };
  }
}

@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
export class AdminMarketsController {
  constructor(
    private readonly markets: MarketsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('markets')
  @RequireStepUp()
  @RequirePermissions(PERMISSIONS.MARKETS_CONFIGURE)
  @ApiZodBody(createMarketSchema)
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createMarketSchema)) body: z.infer<typeof createMarketSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<MarketDto> {
    const market = await this.markets.create(body, {
      actorType: 'STAFF',
      actorUserId: auth.user.id,
      requestId: ctx.requestId,
    });
    return this.markets.toDto(market);
  }

  /** Halt stops new orders (cancels still work); resume reopens order entry. */
  @Patch('markets/:symbol/status')
  @RequireStepUp()
  @RequirePermissions(PERMISSIONS.MARKETS_CONFIGURE)
  @ApiZodBody(marketStatusSchema)
  async setStatus(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(symbolParam)) params: z.infer<typeof symbolParam>,
    @Body(new ZodValidationPipe(marketStatusSchema)) body: z.infer<typeof marketStatusSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<MarketDto> {
    const market = await this.markets.setStatus(params.symbol, body.status, {
      actorType: 'STAFF',
      actorUserId: auth.user.id,
      requestId: ctx.requestId,
    });
    return this.markets.toDto(market);
  }

  /** Engine and settlement progress per market (backlog/lag), for operations. */
  @Get('engine/status')
  @RequirePermissions(PERMISSIONS.REPORTS_READ)
  async engineStatus() {
    const rows = await this.prisma.$queryRaw<
      {
        symbol: string;
        status: string;
        commands_enqueued: bigint;
        commands_processed: bigint | null;
        events_emitted: bigint | null;
        events_settled: bigint | null;
        state_hash: string | null;
      }[]
    >`
      SELECT m."symbol", m."status"::text AS "status", m."next_command_seq" AS "commands_enqueued",
             e."last_command_seq" AS "commands_processed", e."last_event_seq" AS "events_emitted",
             s."last_event_seq" AS "events_settled", e."state_hash"
        FROM "markets" m
        LEFT JOIN "engine_market_state" e ON e."market_id" = m."id"
        LEFT JOIN "settlement_state" s ON s."market_id" = m."id"
       ORDER BY m."symbol"`;
    return {
      markets: rows.map((r) => ({
        symbol: r.symbol,
        status: r.status,
        commandsEnqueued: r.commands_enqueued.toString(),
        commandsProcessed: (r.commands_processed ?? 0n).toString(),
        engineBacklog: (r.commands_enqueued - (r.commands_processed ?? 0n)).toString(),
        eventsEmitted: (r.events_emitted ?? 0n).toString(),
        eventsSettled: (r.events_settled ?? 0n).toString(),
        settlementLag: ((r.events_emitted ?? 0n) - (r.events_settled ?? 0n)).toString(),
        stateHash: r.state_hash,
      })),
    };
  }
}
