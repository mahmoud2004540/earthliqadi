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
  .regex(
    /^[A-Z0-9]{2,16}-[A-Z0-9]{2,16}(-PERP)?$/,
    'Market symbol must look like BASE-QUOTE or BASE-QUOTE-PERP',
  );

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
  /** Perpetuals only: the order may only reduce the current position. */
  reduceOnly: z.boolean().optional(),
  /**
   * Stop orders only: trigger when the last price rises to (`above`) or falls
   * to (`below`) the stop price. Default: buy above, sell below (stop-loss).
   * Take-profit: a sell `above` or a buy `below`.
   */
  trigger: z.enum(['above', 'below']).optional(),
  /**
   * Hidden order (ADR-0025): rests and matches normally but is left out of
   * the public order book. Limit orders with gtc or post_only only.
   */
  hidden: z.boolean().optional(),
});
export type PlaceOrderInput = z.input<typeof placeOrderSchema>;

/**
 * Scaled order (ADR-0025): `count` limit orders at evenly spaced prices from
 * `startPrice` to `endPrice`, splitting `quantity` by `distribution`
 * (`increasing` puts more size towards `endPrice`). Order i gets the
 * clientOrderId `${clientOrderIdPrefix}-${i}`.
 */
export const scaleOrderSchema = z.object({
  market: marketSymbolSchema,
  clientOrderIdPrefix: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  side: z.enum(ORDER_SIDES),
  quantity: amountStringSchema,
  startPrice: amountStringSchema,
  endPrice: amountStringSchema,
  count: z.number().int().min(2).max(20),
  distribution: z.enum(['flat', 'increasing', 'decreasing']).default('flat'),
  timeInForce: z.enum(['gtc', 'post_only']).default('gtc'),
  reduceOnly: z.boolean().optional(),
  hidden: z.boolean().optional(),
});

/** New remaining quantity (must be lower than the current remaining quantity). */
export const reduceOrderSchema = z.object({ remainingQuantity: amountStringSchema });

export const orderListQuerySchema = z.object({
  status: z.enum(['open', 'closed', 'all']).default('all'),
  market: marketSymbolSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const MARKET_KINDS = ['spot', 'perpetual'] as const;

const indexSourceSchema = z.discriminatedUnion('type', [
  /** Mid price (or recent last trade) of a market on this exchange. */
  z.object({ type: z.literal('spot'), market: marketSymbolSchema }),
  /**
   * Chainlink-compatible price feed (AggregatorV3Interface) on the configured
   * chain; the answer is converted to quote units using the feed's decimals.
   */
  z.object({
    type: z.literal('oracle'),
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    label: z.string().trim().min(2).max(48),
  }),
  /** Deterministic random walk for automated tests only (refused outside local/ci). */
  z.object({
    type: z.literal('simulated'),
    start: amountStringSchema,
    volatilityBps: z.number().int().min(1).max(500),
    seed: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  }),
]);

export const riskTierSchema = z.object({
  /** Upper bound of position notional for the tier, in quote units. */
  maxNotional: amountStringSchema,
  maxLeverage: z.number().int().min(1).max(125),
  /** Maintenance margin rate in basis points. */
  mmrBps: z.number().int().min(1).max(5000),
});

/** Perpetual risk parameters (ADR-0011). Settled against real collateral. */
export const perpConfigSchema = z.object({
  defaultLeverage: z.number().int().min(1).max(125),
  tiers: z.array(riskTierSchema).min(1).max(10),
  fundingIntervalSeconds: z.number().int().min(60).max(86_400),
  /** Maximum funding rate per interval, ± basis points. */
  fundingClampBps: z.number().int().min(1).max(500),
  /** Maximum distance of the mark price from the index, basis points. */
  maxBasisBps: z.number().int().min(0).max(500),
  liquidationFeeBps: z.number().int().min(0).max(500),
  /** Order prices must be within this distance of the mark price. */
  priceBandBps: z.number().int().min(10).max(5000),
  index: z.object({
    sources: z.array(indexSourceSchema).min(1).max(10),
    staleSeconds: z.number().int().min(1).max(3600),
    outlierBps: z.number().int().min(1).max(5000),
    minSources: z.number().int().min(1).max(10),
  }),
});
export type PerpConfigInput = z.infer<typeof perpConfigSchema>;

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
  kind: z.enum(MARKET_KINDS).default('spot'),
  perp: perpConfigSchema.optional(),
});

export const leverageSchema = z.object({
  market: marketSymbolSchema,
  leverage: z.number().int().min(1).max(125),
});

/**
 * Take-profit / stop-loss for the whole open position (ADR-0017): reduce-only
 * stop-market orders in a one-cancels-the-other pair. Replaces any existing pair.
 */
export const tpslSchema = z
  .object({
    market: marketSymbolSchema,
    takeProfit: amountStringSchema.optional(),
    stopLoss: amountStringSchema.optional(),
  })
  .refine((v) => v.takeProfit !== undefined || v.stopLoss !== undefined, {
    message: 'Set a takeProfit, a stopLoss, or both',
  });

/** Adds margin to an isolated position (from the available balance). */
export const addMarginSchema = z.object({
  market: marketSymbolSchema,
  amount: amountStringSchema,
});

export const insuranceSeedSchema = z.object({
  asset: assetCodeSchema,
  amount: amountStringSchema,
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
  /** Both sides settle against tokens held in the on-chain vault. */
  vaultBacked: boolean;
  kind: (typeof MARKET_KINDS)[number];
  /** Perpetuals only. */
  perp: PerpMarketInfoDto | null;
}

export interface PerpMarketInfoDto {
  defaultLeverage: number;
  maxLeverage: number;
  tiers: { maxNotional: string; maxLeverage: number; mmrBps: number }[];
  fundingIntervalSeconds: number;
  fundingClampBps: number;
  liquidationFeeBps: number;
  priceBandBps: number;
  /** Human-readable index source labels; simulated sources say so. */
  indexSources: string[];
}

/** Mark/index/funding snapshot for a perpetual market. Prices in quote units. */
export interface PerpStatsDto {
  market: string;
  markPrice: string | null;
  indexPrice: string | null;
  /** Last computed funding rate for the current interval, percent string (e.g. "0.0100"). */
  predictedFundingRate: string | null;
  lastFundingRate: string | null;
  nextFundingAt: string | null;
  /** Index sources used in the latest sample. */
  sourcesUsed: number;
  /** True when there is no reliable index: funding and liquidations pause. */
  indexStale: boolean;
  sampledAt: string | null;
}

export interface PositionDto {
  market: string;
  side: 'long' | 'short' | 'flat';
  /** Absolute size in base units. */
  size: string;
  entryPrice: string | null;
  markPrice: string | null;
  /** Estimated: where equity falls to the maintenance margin at the current tier. */
  liquidationPrice: string | null;
  bankruptcyPrice: string | null;
  margin: string;
  leverage: number;
  unrealizedPnl: string | null;
  realizedPnl: string;
  fundingPnl: string;
  status: 'normal' | 'liquidating';
  asset: string;
}

export interface FundingRoundDto {
  market: string;
  fundingTime: string;
  /** Percent string. */
  rate: string;
  markPrice: string;
  collected: string;
  distributed: string;
  positions: number;
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
  /** Stop orders: effective trigger direction. */
  trigger: 'above' | 'below' | null;
  quantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  status: OrderStatusDto;
  rejectReason: string | null;
  cancelReason: string | null;
  cancelRequested: boolean;
  reduceOnly: boolean;
  liquidation: boolean;
  /** Left out of the public order book (ADR-0025). */
  hidden: boolean;
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

/** Perpetual margin mode (ADR-0021). */
export const marginModeSchema = z.object({ mode: z.enum(['isolated', 'cross']) });
