import { z } from 'zod';
import { MAX_ASSET_SCALE, assetCodeSchema } from '../money/amount';

export const ASSET_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const JOURNAL_ENTRY_TYPES = [
  'SIMULATED_DEPOSIT',
  'BALANCE_HOLD',
  'BALANCE_RELEASE',
  'REVERSAL',
  'TRADE',
  'PAPER_FAUCET_GRANT',
  'MARGIN_TRANSFER',
  'FUNDING',
  'INSURANCE_FUND_SEED',
  'CHAIN_DEPOSIT',
  'WITHDRAWAL_HOLD',
  'WITHDRAWAL_FINAL',
  'WITHDRAWAL_RELEASE',
  'INTERNAL_TRANSFER',
  'VAULT_DEPOSIT',
  'VAULT_REDEMPTION',
] as const;
export type JournalEntryType = (typeof JOURNAL_ENTRY_TYPES)[number];

/** Amounts in DTOs are decimal strings at the asset's full scale. Never numbers. */
export interface AssetDto {
  code: string;
  name: string;
  scale: number;
  status: AssetStatus;
  /** On-chain token backing the asset in the vault (null: not chain-backed). */
  chainToken: string | null;
}

export interface BalanceDto {
  asset: string;
  name: string;
  scale: number;
  available: string;
  locked: string;
  /** Isolated margin backing open perpetual positions . */
  margin: string;
  /** available + locked + margin. */
  total: string;
}

export interface LedgerHistoryItemDto {
  postingId: string;
  entryId: string;
  entryType: JournalEntryType;
  asset: string;
  /** Which of the user's balances changed. */
  bucket: 'available' | 'locked' | 'margin' | 'withdrawing';
  /** Signed change from the user's perspective, e.g. "+1.50000000" or "-0.25000000". */
  change: string;
  createdAt: string;
}

export const createAssetSchema = z.object({
  code: assetCodeSchema,
  name: z.string().trim().min(2).max(64),
  scale: z.number().int().min(0).max(MAX_ASSET_SCALE),
});

export const assetStatusSchema = z.object({ status: z.enum(ASSET_STATUSES) });

export const ledgerHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
});

/**
 * Account overview (ADR-0028): every balance with where it is held and, when
 * a price exists, its value in the valuation asset. Values are indicative
 * (last traded price), never a quote or an offer.
 */
export interface AccountOverviewDto {
  /** Asset values are expressed in, or null when it does not exist here. */
  valuationAsset: string | null;
  asOf: string;
  /** Sum of valued balances plus unrealized perpetual PnL, in the valuation asset. */
  totalValue: string | null;
  /** Unrealized PnL of open perpetual positions settled in the valuation asset. */
  unrealizedPnl: string | null;
  assets: {
    asset: string;
    name: string;
    available: string;
    locked: string;
    margin: string;
    total: string;
    /**
     * vault: backed by the on-chain vault and claimable with a balance proof.
     * ledger: held only on the platform ledger (test assets).
     */
    custody: 'vault' | 'ledger';
    /** Price in the valuation asset and how it was obtained. */
    price: string | null;
    priceSource: 'reference' | 'last_trade' | null;
    /** Market whose last trade priced it. */
    priceMarket: string | null;
    value: string | null;
  }[];
  /** Assets with a balance but no price (not included in totalValue). */
  unvalued: string[];
}
