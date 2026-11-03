import type { PublicTradeDto } from '@platform/shared';

/** Newest first, unique by settlement sequence (a resent trade never shows twice). */
export function mergeTrades(prev: PublicTradeDto[], incoming: PublicTradeDto[]): PublicTradeDto[] {
  const bySeq = new Map<string, PublicTradeDto>();
  for (const t of [...incoming, ...prev]) if (!bySeq.has(t.seq)) bySeq.set(t.seq, t);
  return [...bySeq.values()]
    .sort((a, b) => (BigInt(b.seq) > BigInt(a.seq) ? 1 : BigInt(b.seq) < BigInt(a.seq) ? -1 : 0))
    .slice(0, 60);
}
