import type { Prisma } from '@prisma/client';
import { toMinorUnits } from '../ledger/ledger-domain';
import type { PerpConfig } from './perp-config';

type Db = Pick<Prisma.TransactionClient, 'perpPriceSample'>;

/** How old the latest sample may be before the mark counts as unavailable. */
export function markMaxAgeMs(config: PerpConfig): number {
  return Math.max(config.index.staleSeconds, 5) * 2000;
}

/** Latest mark price if fresh, else null (quote minor units per whole base unit). */
export async function currentMark(
  db: Db,
  marketId: string,
  config: PerpConfig,
  now = new Date(),
): Promise<bigint | null> {
  const s = await db.perpPriceSample.findFirst({
    where: { marketId },
    orderBy: { sampledAt: 'desc' },
  });
  if (!s || now.getTime() - s.sampledAt.getTime() > markMaxAgeMs(config)) return null;
  return toMinorUnits(s.markPrice);
}
