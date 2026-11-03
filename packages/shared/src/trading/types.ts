import { z } from 'zod';
import { amountStringSchema, assetCodeSchema } from '../money/amount';

export const ORDER_SIDES = ['buy', 'sell'] as const;
export const ORDER_TYPES = ['limit', 'market', 'stop_limit', 'stop_market'] as const;
export const TIME_IN_FORCE = ['gtc', 'ioc', 'fok', 'post_only'] as const;
export const ORDER_STATUSES = [
  'pending_new',
  'pending_trigger',
  'open',
  'partially_filled',
  'filled',
  'cancelled',
  'rejected',
] as const;
export const MARKET_STATUSES = ['ACTIVE', 'HALTED'] as const;

export type OrderSideDto = (typeof ORDER_SIDES)[number];
export type OrderTypeDto = (typeof ORDER_TYPES)[number];
export type TimeInForceDto = (typeof TIME_IN_FORCE)[number];
export type OrderStatusDto = (typeof ORDER_STATUSES)[number];

export const marketSymbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,16}-[A-Z0-9]{2,16}$/, 'Market symbol must look like BASE-QUOTE');

export const clientOrderIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'clientOrderId must be 1-64 characters of [A-Za-z0-9_-]');

/** Prices are quote per one whole base unit; quantities are base units. Decimal strings only. */
export const placeOrderSchema = z.object({
  market: marketSymbolSchema,
  clientOrderId: clientOrderIdSchema,
  side: z.enum(ORDER_SIDES),
  type: z.enum(ORDER_TYPES),
  timeInForce: z.enum(TIME_IN_FORCE).optional(),
  /** Limit price, or the protection (worst acceptable) price for market orders. */
  price: amountStringSchema.optional(),
  stopPrice: amountStringSchema.optional(),
  quantity: amountStringSchema,
});
export type PlaceOrderInput = z.input<typeof placeOrderSchema>;

/** New remaining quantity (must be lower than the current remaining quantity). */
export const reduceOrderSchema = z.object({ remainingQuantity: amountStringSchema });

export const orderListQuerySchema = z.object({
  status: z.enum(['open', 'closed', 'all']).default('all'),
  market: marketSymbolSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createMarketSchema = z.object({
  base: assetCodeSchema,
  quote: assetCodeSchema,
  /** Price increment in quote units, e.g. "0.01". */
  tickSize: amountStringSchema,
  /** Quantity increment in base units, e.g. "0.0001". */
  lotSize: amountStringSchema,
  minQuantity: amountStringSchema.optional(),
  makerFeeBps: z.number().int().min(0).max(1000),
  takerFeeBps: z.number().int().min(0).max(1000),
});

export const marketStatusSchema = z.object({ status: z.enum(MARKET_STATUSES) });

export interface MarketDto {
  symbol: string;
  base: string;
  quote: string;
  tickSize: string;
  lotSize: string;
  minQuantity: string;
  makerFeeBps: number;
  takerFeeBps: number;
  status: (typeof MARKET_STATUSES)[number];
}

export interface OrderDto {
  id: string;
  clientOrderId: string;
  market: string;
  side: OrderSideDto;
  type: OrderTypeDto;
  timeInForce: TimeInForceDto;
  price: string | null;
  stopPrice: string | null;
  quantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  status: OrderStatusDto;
  rejectReason: string | null;
  cancelReason: string | null;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TradeDto {
  id: string;
  market: string;
  orderId: string;
  side: OrderSideDto;
  liquidity: 'maker' | 'taker';
  price: string;
  quantity: string;
  quoteAmount: string;
  fee: string;
  feeAsset: string;
  createdAt: string;
}
