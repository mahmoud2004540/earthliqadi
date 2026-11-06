import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  formatAmountTrimmed,
  parseAmount,
  type PerpConfigInput,
  type PerpMarketInfoDto,
} from '@platform/shared';
import { AppError } from '../common/app-error';
import { validateTiers, type RiskTier } from './perp-math';

export type IndexSource =
  | { type: 'spot'; market: string }
  | { type: 'oracle'; address: string; label: string }
  | { type: 'simulated'; start: bigint; volatilityBps: number; seed: string };

/** Parsed perpetual risk parameters; amounts in quote minor units. */
export interface PerpConfig {
  defaultLeverage: number;
  tiers: RiskTier[];
  fundingIntervalSeconds: number;
  fundingClampBps: number;
  maxBasisBps: number;
  liquidationFeeBps: number;
  priceBandBps: number;
  index: {
    sources: IndexSource[];
    staleSeconds: number;
    outlierBps: number;
    minSources: number;
  };
}

function invalid(message: string): AppError {
  return new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', message, [
    { path: 'perp', message },
  ]);
}

function amount(value: string, scale: number, path: string): bigint {
  try {
    const v = parseAmount(value, scale);
    if (v <= 0n) throw new Error('must be positive');
    return v;
  } catch (err) {
    throw invalid(`${path}: ${(err as Error).message}`);
  }
}

/** Validates the admin input and returns the JSON stored in markets.perp_config. */
export function buildPerpConfig(input: PerpConfigInput, quoteScale: number): Prisma.InputJsonValue {
  const tiers: RiskTier[] = input.tiers.map((t, i) => ({
    maxNotional: amount(t.maxNotional, quoteScale, `tiers[${i}].maxNotional`),
    maxLeverage: t.maxLeverage,
    mmrBps: t.mmrBps,
  }));
  const tierError = validateTiers(tiers);
  if (tierError) throw invalid(tierError);
  if (input.defaultLeverage > tiers[0]!.maxLeverage)
    throw invalid('defaultLeverage exceeds the first tier maximum');
  if (input.index.minSources > input.index.sources.length)
    throw invalid('index.minSources exceeds the number of sources');
  return {
    defaultLeverage: input.defaultLeverage,
    tiers: tiers.map((t) => ({ ...t, maxNotional: t.maxNotional.toString() })),
    fundingIntervalSeconds: input.fundingIntervalSeconds,
    fundingClampBps: input.fundingClampBps,
    maxBasisBps: input.maxBasisBps,
    liquidationFeeBps: input.liquidationFeeBps,
    priceBandBps: input.priceBandBps,
    index: {
      sources: input.index.sources.map((s, i) =>
        s.type === 'spot'
          ? { type: 'spot', market: s.market }
          : s.type === 'oracle'
            ? { type: 'oracle', address: s.address.toLowerCase(), label: s.label }
            : {
                type: 'simulated',
                start: amount(s.start, quoteScale, `index.sources[${i}].start`).toString(),
                volatilityBps: s.volatilityBps,
                seed: s.seed,
              },
      ),
      staleSeconds: input.index.staleSeconds,
      outlierBps: input.index.outlierBps,
      minSources: input.index.minSources,
    },
  };
}

type StoredConfig = {
  defaultLeverage: number;
  tiers: { maxNotional: string; maxLeverage: number; mmrBps: number }[];
  fundingIntervalSeconds: number;
  fundingClampBps: number;
  maxBasisBps: number;
  liquidationFeeBps: number;
  priceBandBps: number;
  index: {
    sources: (
      | { type: 'spot'; market: string }
      | { type: 'oracle'; address: string; label: string }
      | { type: 'simulated'; start: string; volatilityBps: number; seed: string }
    )[];
    staleSeconds: number;
    outlierBps: number;
    minSources: number;
  };
};

export function parsePerpConfig(json: Prisma.JsonValue | null): PerpConfig {
  if (json === null || typeof json !== 'object' || Array.isArray(json))
    throw new Error('Market has no perpetual configuration');
  const c = json as unknown as StoredConfig;
  return {
    ...c,
    tiers: c.tiers.map((t) => ({ ...t, maxNotional: BigInt(t.maxNotional) })),
    index: {
      ...c.index,
      sources: c.index.sources.map((s) =>
        s.type === 'simulated' ? { ...s, start: BigInt(s.start) } : s,
      ),
    },
  };
}

export function sourceLabel(s: IndexSource, quoteScale: number): string {
  if (s.type === 'spot') return `Exchange market ${s.market} (mid price)`;
  if (s.type === 'oracle') return `Oracle feed ${s.label} (${s.address})`;
  return `TEST-ONLY SIMULATED feed "${s.seed}" (random walk from ${formatAmountTrimmed(s.start, quoteScale)}, not a real price)`;
}

export function perpInfoDto(c: PerpConfig, quoteScale: number): PerpMarketInfoDto {
  return {
    defaultLeverage: c.defaultLeverage,
    maxLeverage: c.tiers[0]!.maxLeverage,
    tiers: c.tiers.map((t) => ({
      maxNotional: formatAmountTrimmed(t.maxNotional, quoteScale),
      maxLeverage: t.maxLeverage,
      mmrBps: t.mmrBps,
    })),
    fundingIntervalSeconds: c.fundingIntervalSeconds,
    fundingClampBps: c.fundingClampBps,
    liquidationFeeBps: c.liquidationFeeBps,
    priceBandBps: c.priceBandBps,
    indexSources: c.index.sources.map((s) => sourceLabel(s, quoteScale)),
  };
}
