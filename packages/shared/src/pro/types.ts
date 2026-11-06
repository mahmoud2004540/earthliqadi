import { z } from 'zod';
import { amountStringSchema, assetCodeSchema } from '../money/amount';
import { marketSymbolSchema, placeOrderSchema, type OrderDto } from '../trading/types';

/** Agent API key scopes (ADR-0017). There is deliberately no withdrawal scope. */
export const API_KEY_SCOPES = ['read', 'trade'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const cidrSchema = z
  .string()
  .regex(/^(\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?|[0-9a-fA-F:]+(\/\d{1,3})?)$/, 'IPv4/IPv6 or CIDR');

export const apiKeyRequestSchema = z.object({
  label: z.string().trim().min(2).max(48),
  /** Hex-encoded raw Ed25519 public key (32 bytes). The private key stays with you. */
  publicKey: z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/)
    .transform((s) => s.replace(/^0x/, '').toLowerCase()),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(2),
  allowedIps: z.array(cidrSchema).max(20).default([]),
  expiresInDays: z.number().int().min(1).max(365),
});
export type ApiKeyRequestInput = z.input<typeof apiKeyRequestSchema>;

/** Second step: the wallet's signature over the challenge message. */
export const apiKeyCreateSchema = z.object({
  challengeId: z.string().regex(/^[A-Za-z0-9]{16,32}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

export interface ApiKeyChallengeDto {
  challengeId: string;
  /** Sign this exact text with the account's wallet (personal_sign). */
  message: string;
  expiresInSeconds: number;
}

export interface ApiKeyDto {
  id: string;
  label: string;
  publicKey: string;
  scopes: ApiKeyScope[];
  allowedIps: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Up to 20 orders in one request; each is validated and placed independently. */
export const batchOrdersSchema = z.object({
  orders: z.array(placeOrderSchema).min(1).max(20),
});

export const cancelAllSchema = z.object({ market: marketSymbolSchema.optional() });

/** Dead-man switch. 0 disables it; otherwise 5 s to 1 day. */
export const cancelAfterSchema = z.object({
  timeoutSeconds: z.union([z.literal(0), z.number().int().min(5).max(86_400)]),
});

export interface BatchOrderResultDto {
  clientOrderId: string;
  status: number;
  order?: OrderDto;
  error?: { code: string; message: string };
}

/** Sub-accounts (ADR-0017): act as one with the `X-Sub-Account: <id>` header. */
export const createSubAccountSchema = z.object({ label: z.string().trim().min(2).max(48) });

const accountRef = z.union([z.literal('main'), z.uuid()]);
export const subTransferSchema = z
  .object({
    from: accountRef,
    to: accountRef,
    asset: assetCodeSchema,
    amount: amountStringSchema,
    /** Client-chosen key; a retry with the same key never transfers twice. */
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .refine((t) => t.from !== t.to, { message: 'from and to must differ', path: ['to'] });

export interface SubAccountDto {
  id: string;
  label: string;
  createdAt: string;
}

/** Public fee schedule (ADR-0018). */
export interface FeeScheduleDto {
  /** Volume counts traded notional in these quote assets (normalised to 6 decimals). */
  volumeAssets: string;
  tiers: {
    tier: number;
    minVolume30d: string;
    takerDiscountBps: number;
    makerDiscountBps: number;
  }[];
  referralShareBps: number;
  referralDurationDays: number;
  notes: string[];
}

export interface MyFeesDto {
  tier: number;
  volume30d: string;
  takerDiscountBps: number;
  makerDiscountBps: number;
  computedAt: string | null;
}

export interface ReferralSummaryDto {
  code: string | null;
  referred: number;
  earnings: { asset: string; amount: string }[];
}

export interface PointsEntryDto {
  rank: number;
  account: string;
  points: string;
}

/** Replaces the whole fee schedule (tier 0 must be the zero tier). */
export const feeScheduleSchema = z.object({
  tiers: z
    .array(
      z.object({
        tier: z.number().int().min(0).max(20),
        minVolume30d: amountStringSchema,
        takerDiscountBps: z.number().int().min(0).max(1000),
        makerDiscountBps: z.number().int().min(0).max(1000),
      }),
    )
    .min(1)
    .max(21),
});

/** Leader vaults (ADR-0019). */
export const createVaultSchema = z.object({
  name: z
    .string()
    .trim()
    .min(3)
    .max(48)
    .regex(/^[A-Za-z0-9 ._-]+$/),
  description: z.string().trim().max(280).default(''),
  asset: assetCodeSchema,
  /** Leader's share of profits above each holder's high-water mark; fixed forever. */
  profitShareBps: z.number().int().min(0).max(3000),
  maxLeverage: z.number().int().min(1).max(50),
  maxDrawdownBps: z.number().int().min(100).max(9000),
  initialDeposit: amountStringSchema,
});

export const vaultDepositSchema = z.object({
  amount: amountStringSchema,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});

export const vaultRedeemSchema = z.object({
  shares: z.union([z.literal('all'), z.string().regex(/^[1-9][0-9]{0,30}$/)]),
});

/** TWAP / iceberg (ADR-0020). Prices: limit for each child (TWAP: worst acceptable). */
export const algoOrderSchema = z
  .object({
    market: marketSymbolSchema,
    kind: z.enum(['twap', 'iceberg']),
    side: z.enum(['buy', 'sell']),
    quantity: amountStringSchema,
    /** TWAP: size of each slice. Iceberg: the visible size. */
    sliceQuantity: amountStringSchema,
    price: amountStringSchema,
    /** TWAP only: seconds between slices. */
    intervalSeconds: z.number().int().min(5).max(86_400).optional(),
    reduceOnly: z.boolean().optional(),
  })
  .refine((a) => (a.kind === 'twap') === (a.intervalSeconds !== undefined), {
    message: 'intervalSeconds is required for TWAP and not allowed for iceberg',
    path: ['intervalSeconds'],
  });

export interface AlgoOrderDto {
  id: string;
  market: string;
  kind: 'twap' | 'iceberg';
  side: 'buy' | 'sell';
  quantity: string;
  sliceQuantity: string;
  filledQuantity: string;
  price: string;
  intervalSeconds: number | null;
  status: 'running' | 'done' | 'cancelled' | 'failed';
  slicesSent: number;
  lastError: string | null;
  createdAt: string;
}

/** RFQ / block trades (ADR-0020). */
export const rfqRequestSchema = z.object({
  market: marketSymbolSchema,
  side: z.enum(['buy', 'sell']),
  quantity: amountStringSchema,
});
export const rfqQuoteSchema = z.object({ price: amountStringSchema });
export const rfqAcceptSchema = z.object({ quoteId: z.uuid() });
export const rfqMakerSchema = z.object({ userId: z.uuid() });

export interface RfqDto {
  id: string;
  market: string;
  side: 'buy' | 'sell';
  quantity: string;
  status: 'open' | 'filled' | 'cancelled' | 'expired';
  expiresAt: string;
  quotes: { id: string; price: string; expiresAt: string }[];
}

/** Access policy (ADR-0022): restricted regions, sanctions screening, terms of use. */
export const acceptTermsSchema = z.object({
  version: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/),
});

export interface AccessStatusDto {
  /** ISO 3166-1 alpha-2 code from the edge proxy header, or null when unknown. */
  country: string | null;
  /** ISO 3166-2 subdivision ("CA-ON") from the edge, or null when unknown. */
  subdivision: string | null;
  /** Opening new risk is blocked from this region (reduce-only orders and withdrawals stay open). */
  regionRestricted: boolean;
  /** Published list of restricted jurisdictions (ISO 3166-1 alpha-2). */
  restrictedCountries: string[];
  /** Published restricted subdivisions (ISO 3166-2, e.g. "CA-ON"). */
  restrictedSubdivisions: string[];
  termsVersion: string;
}

export interface MyAccessStatusDto extends AccessStatusDto {
  termsAcceptedVersion: string | null;
  termsAccepted: boolean;
  /** The account's wallet is on a loaded sanctions list. */
  sanctioned: boolean;
}
