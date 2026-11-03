import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  bookQuerySchema,
  candlesQuerySchema,
  marketSymbolSchema,
  tradesQuerySchema,
  type CandleDto,
  type OrderBookDto,
  type PublicTradeDto,
  type TickerDto,
} from '@platform/shared';
import { z } from 'zod';
import { Public } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MarketDataService } from './market-data.service';

const symbolParam = z.object({ symbol: marketSymbolSchema });

/** Public REST snapshots of market data (WebSocket offers the same, live). */
@ApiTags('market-data')
@Public()
@Controller({ path: 'markets', version: '1' })
export class MarketDataController {
  constructor(private readonly data: MarketDataService) {}

  @Get('tickers')
  async tickers(): Promise<{ tickers: TickerDto[] }> {
    return { tickers: await this.data.tickers() };
  }

  @Get(':symbol/ticker')
  ticker(
    @Param(new ZodValidationPipe(symbolParam)) p: z.infer<typeof symbolParam>,
  ): Promise<TickerDto> {
    return this.data.ticker(p.symbol);
  }

  @Get(':symbol/book')
  book(
    @Param(new ZodValidationPipe(symbolParam)) p: z.infer<typeof symbolParam>,
    @Query(new ZodValidationPipe(bookQuerySchema)) q: z.infer<typeof bookQuerySchema>,
  ): Promise<OrderBookDto> {
    return this.data.book(p.symbol, q.depth);
  }

  @Get(':symbol/trades')
  async trades(
    @Param(new ZodValidationPipe(symbolParam)) p: z.infer<typeof symbolParam>,
    @Query(new ZodValidationPipe(tradesQuerySchema)) q: z.infer<typeof tradesQuerySchema>,
  ): Promise<{ trades: PublicTradeDto[] }> {
    return { trades: await this.data.trades(p.symbol, q.limit) };
  }

  @Get(':symbol/candles')
  candles(
    @Param(new ZodValidationPipe(symbolParam)) p: z.infer<typeof symbolParam>,
    @Query(new ZodValidationPipe(candlesQuerySchema)) q: z.infer<typeof candlesQuerySchema>,
  ): Promise<{ seq: string; data: CandleDto[] }> {
    return this.data.candles(p.symbol, q.interval, q.limit);
  }
}
