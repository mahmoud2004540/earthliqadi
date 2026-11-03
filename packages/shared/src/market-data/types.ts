import { z } from 'zod';
import { marketSymbolSchema } from '../trading/types';

/** All prices/quantities are decimal strings (ADR-0009). */
export const CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export const CANDLE_INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
};

export type MarketDataState = 'live' | 'delayed' | 'halted';

export interface MarketDataStatus {
  state: MarketDataState;
  /** Commands not yet processed by the engine. */
  engineBacklog: number;
  /** Engine events not yet settled. */
  settlementLag: number;
}

/** [price, quantity] */
export type BookLevel = [string, string];

export interface OrderBookDto {
  market: string;
  /** Settlement sequence this snapshot reflects. */
  seq: string;
  bids: BookLevel[];
  asks: BookLevel[];
  status: MarketDataStatus;
}

export interface PublicTradeDto {
  /** Engine event sequence of the fill (monotonic per market). */
  seq: string;
  price: string;
  quantity: string;
  /** Side of the taker (aggressor). */
  takerSide: 'buy' | 'sell';
  executedAt: string;
}

export interface CandleDto {
  /** Bucket start, ISO 8601. */
  time: string;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Base volume. */
  volume: string;
  /** Quote volume. */
  quoteVolume: string;
  trades: number;
}

export interface TickerDto {
  market: string;
  seq: string;
  last: string | null;
  open24h: string | null;
  high24h: string | null;
  low24h: string | null;
  /** Percentage change over 24h with 2 decimals, e.g. "-1.25". */
  change24hPct: string | null;
  volume24h: string;
  quoteVolume24h: string;
  bestBid: string | null;
  bestAsk: string | null;
  status: MarketDataStatus;
}

export const bookQuerySchema = z.object({
  depth: z.coerce.number().int().min(1).max(100).default(50),
});
export const tradesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const candlesQuerySchema = z.object({
  interval: z.enum(CANDLE_INTERVALS).default('1m'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// --------------------------------------------------------------- WebSocket

export const WS_PUBLIC_CHANNELS = ['book', 'trades', 'ticker', 'candles'] as const;
export const WS_CHANNELS = [...WS_PUBLIC_CHANNELS, 'orders'] as const;
export type WsChannel = (typeof WS_CHANNELS)[number];

const subscription = z.object({
  channel: z.enum(WS_CHANNELS),
  market: marketSymbolSchema,
  interval: z.enum(CANDLE_INTERVALS).optional(),
});

export const wsClientMessageSchema = z.discriminatedUnion('op', [
  subscription.extend({ op: z.literal('subscribe') }),
  subscription.extend({ op: z.literal('unsubscribe') }),
  z.object({ op: z.literal('ping') }),
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

export type WsServerMessage =
  | { type: 'subscribed'; channel: WsChannel; market: string; interval?: CandleInterval }
  | { type: 'unsubscribed'; channel: WsChannel; market: string }
  | { type: 'book'; data: OrderBookDto }
  | { type: 'trades'; market: string; snapshot: boolean; data: PublicTradeDto[] }
  | { type: 'ticker'; data: TickerDto }
  | { type: 'candles'; market: string; interval: CandleInterval; seq: string; data: CandleDto[] }
  | { type: 'orders'; market: string; data: unknown[] }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };
