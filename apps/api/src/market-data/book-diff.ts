import type { BookLevel } from '@platform/shared';

/**
 * Changes between two views of one side of the book (ADR-0017): every price
 * whose quantity changed, with "0" for a level that left the view. Applying
 * the result to `prev` yields `next` exactly.
 */
export function diffLevels(prev: readonly BookLevel[], next: readonly BookLevel[]): BookLevel[] {
  const before = new Map(prev);
  const after = new Map(next);
  const out: BookLevel[] = [];
  for (const [price, qty] of next) if (before.get(price) !== qty) out.push([price, qty]);
  for (const [price] of prev) if (!after.has(price)) out.push([price, '0']);
  return out;
}

/** Applies a diff (client-side reference implementation, also used in tests). */
export function applyLevels(
  levels: readonly BookLevel[],
  changes: readonly BookLevel[],
  side: 'bids' | 'asks',
): BookLevel[] {
  const m = new Map(levels);
  for (const [price, qty] of changes) {
    if (/^0(\.0*)?$/.test(qty)) m.delete(price);
    else m.set(price, qty);
  }
  const sorted = [...m.entries()].sort((a, b) => {
    const d = Number(a[0]) - Number(b[0]);
    return side === 'bids' ? -d : d;
  });
  return sorted;
}
