import { z } from 'zod';
import { MAX_ASSET_SCALE, assetCodeSchema } from '../money/amount';

export const ASSET_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const JOURNAL_ENTRY_TYPES = [
  'SIMULATED_DEPOSIT',
  'BALANCE_HOLD',
  'BALANCE_RELEASE',
  'REVERSAL',
] as const;
export type JournalEntryType = (typeof JOURNAL_ENTRY_TYPES)[number];

/** Amounts in DTOs are decimal strings at the asset's full scale. Never numbers. */
export interface AssetDto {
  code: string;
  name: string;
  scale: number;
  status: AssetStatus;
}

export interface BalanceDto {
  asset: string;
  name: string;
  scale: number;
  available: string;
  locked: string;
  total: string;
}

export interface LedgerHistoryItemDto {
  postingId: string;
  entryId: string;
  entryType: JournalEntryType;
  asset: string;
  /** Which of the user's balances changed. */
  bucket: 'available' | 'locked';
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
