import { HttpStatus } from '@nestjs/common';
import type { JournalEntryType, LedgerAccountType, PostingDirection } from '@prisma/client';
import { MAX_MINOR_UNITS } from '@platform/shared';
import { createHash } from 'node:crypto';
import { AppError } from '../common/app-error';

/**
 * Pure ledger rules (no I/O). The database enforces the same invariants as a
 * backstop; these checks give precise errors before anything is written.
 */

export interface AccountSpec {
  normalSide: PostingDirection;
  allowNegative: boolean;
  userOwned: boolean;
}

export const ACCOUNT_SPECS: Record<LedgerAccountType, AccountSpec> = {
  USER_AVAILABLE: { normalSide: 'CREDIT', allowNegative: false, userOwned: true },
  USER_LOCKED: { normalSide: 'CREDIT', allowNegative: false, userOwned: true },
  FEE_REVENUE: { normalSide: 'CREDIT', allowNegative: false, userOwned: false },
  SUSPENSE: { normalSide: 'CREDIT', allowNegative: true, userOwned: false },
  SIMULATED_CUSTODY: { normalSide: 'DEBIT', allowNegative: false, userOwned: false },
  // Paper trading faucet (ADR-0010): debit-normal like custody; grows with every grant.
  PAPER_FAUCET: { normalSide: 'DEBIT', allowNegative: false, userOwned: false },
  // Perpetuals (ADR-0011). Isolated margin held for open positions.
  USER_MARGIN: { normalSide: 'CREDIT', allowNegative: false, userOwned: true },
  // Pays out realised PnL; its (signed) balance equals Σ open entry notional.
  PERP_CLEARING: { normalSide: 'DEBIT', allowNegative: true, userOwned: false },
  INSURANCE_FUND: { normalSide: 'CREDIT', allowNegative: false, userOwned: false },
  PERP_FUNDING_POOL: { normalSide: 'CREDIT', allowNegative: false, userOwned: false },
  // Vault (ADR-0014): mirrors tokens held on-chain; grows with deposits.
  VAULT_CUSTODY: { normalSide: 'DEBIT', allowNegative: false, userOwned: false },
  // Funds reserved for a signed withdrawal until it executes or expires.
  USER_WITHDRAWING: { normalSide: 'CREDIT', allowNegative: false, userOwned: true },
};

export interface PostingRequest {
  accountId: string;
  direction: PostingDirection;
  /** Minor units, strictly positive. */
  amount: bigint;
}

export interface EntryRequest {
  type: JournalEntryType;
  idempotencyKey: string;
  description: string;
  postings: PostingRequest[];
  reversesEntryId?: bigint;
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_.-]{8,128}$/;

function invalid(message: string): AppError {
  return new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', message);
}

/** Structural validation; returns postings sorted by account id (lock order). */
export function validateEntryRequest(req: EntryRequest): PostingRequest[] {
  if (!IDEMPOTENCY_KEY_PATTERN.test(req.idempotencyKey)) {
    throw invalid('Idempotency key must be 8-128 characters of [A-Za-z0-9:_.-]');
  }
  if (req.description.length === 0 || req.description.length > 256) {
    throw invalid('Description must be 1-256 characters');
  }
  if (req.postings.length < 2) throw invalid('A journal entry needs at least two postings');
  const seen = new Set<string>();
  for (const p of req.postings) {
    if (typeof p.amount !== 'bigint' || p.amount <= 0n || p.amount > MAX_MINOR_UNITS) {
      throw invalid('Posting amounts must be positive integers of minor units');
    }
    if (seen.has(p.accountId)) throw invalid('Each account may appear only once per entry');
    seen.add(p.accountId);
  }
  return [...req.postings].sort((a, b) =>
    a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0,
  );
}

/** Debits must equal credits for every asset in the entry. */
export function assertBalancedPerAsset(
  postings: { assetId: string; direction: PostingDirection; amount: bigint }[],
): void {
  const net = new Map<string, bigint>();
  for (const p of postings) {
    net.set(
      p.assetId,
      (net.get(p.assetId) ?? 0n) + (p.direction === 'DEBIT' ? p.amount : -p.amount),
    );
  }
  for (const [assetId, value] of net) {
    if (value !== 0n) throw invalid(`Entry is not balanced for asset ${assetId}`);
  }
}

/** Signed effect of a posting on an account's normal-side balance. */
export function balanceDelta(
  normalSide: PostingDirection,
  direction: PostingDirection,
  amount: bigint,
): bigint {
  return direction === normalSide ? amount : -amount;
}

/** SHA-256 over a canonical form of the request; used to detect idempotency-key reuse. */
export function fingerprintOf(req: EntryRequest): string {
  const canonical = JSON.stringify({
    type: req.type,
    reverses: req.reversesEntryId?.toString() ?? null,
    postings: validateEntryRequest(req).map((p) => [p.accountId, p.direction, p.amount.toString()]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function mirrorPostings(postings: PostingRequest[]): PostingRequest[] {
  return postings.map((p) => ({ ...p, direction: p.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT' }));
}

/** Converts a NUMERIC(38,0) value (Prisma Decimal or text) to bigint without floating point. */
export function toMinorUnits(value: { toFixed(digits?: number): string } | string): bigint {
  const text = typeof value === 'string' ? value : value.toFixed(0);
  if (!/^-?\d+$/.test(text)) throw new Error(`Not an integer amount: ${text}`);
  return BigInt(text);
}
