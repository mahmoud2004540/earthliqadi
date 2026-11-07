'use client';

import {
  formatAmountTrimmed,
  notional,
  parseAmount,
  type BookLevel,
  type OrderBookDto,
} from '@platform/shared';
import type { Dictionary } from '@/i18n';
import { cn } from '@/lib/utils';

/** Display only: a notional cut (not rounded) to two decimals so the columns stay aligned. */
function twoDecimals(v: string | null): string | null {
  if (v === null) return null;
  const [whole, frac = ''] = v.split('.');
  return frac ? `${whole}.${frac.slice(0, 2).padEnd(2, '0')}` : whole!;
}

function Levels({
  levels,
  side,
  max,
  scales,
  onPick,
}: {
  levels: BookLevel[];
  side: 'bid' | 'ask';
  max: number;
  scales: { base: number; quote: number };
  onPick: (price: string) => void;
}) {
  return (
    <ul className={cn('flex flex-col', side === 'ask' && 'flex-col-reverse')}>
      {levels.map(([price, qty]) => {
        // Depth bar width is visual only.
        const width = max > 0 ? Math.max(2, (Number(qty) / max) * 100) : 0;
        return (
          <li key={price}>
            <button
              type="button"
              onClick={() => onPick(price)}
              className="relative grid w-full grid-cols-[1fr_1fr_1.1fr] gap-2 px-3 py-0.5 text-end font-mono text-xs tabular-nums hover:bg-surface-raised"
            >
              <span
                aria-hidden
                className={cn(
                  'absolute inset-y-0 end-0',
                  side === 'bid' ? 'bg-positive/10' : 'bg-negative/10',
                )}
                style={{ width: `${width}%` }}
              />
              <span
                className={cn(
                  'relative text-start',
                  side === 'bid' ? 'text-positive' : 'text-negative',
                )}
              >
                {price}
              </span>
              <span className="relative">{qty}</span>
              <span className="relative text-muted">
                {twoDecimals(notional(price, qty, scales.base, scales.quote)) ?? '—'}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function OrderBook({
  book,
  t,
  scales,
  onPick,
  depth = 15,
}: {
  /** Levels shown per side. */
  depth?: number;
  book: OrderBookDto | null;
  t: Dictionary['terminal'];
  scales: { base: number; quote: number };
  onPick: (price: string) => void;
}) {
  const bids = book?.bids.slice(0, depth) ?? [];
  const asks = book?.asks.slice(0, depth) ?? [];
  const max = Math.max(0, ...[...bids, ...asks].map(([, q]) => Number(q)));
  // Exact: decimal strings → minor units (bigint) → decimal string.
  const spread =
    bids[0] && asks[0]
      ? formatAmountTrimmed(
          parseAmount(asks[0][0], scales.quote) - parseAmount(bids[0][0], scales.quote),
          scales.quote,
        )
      : null;
  return (
    <section aria-label={t.orderBook} className="flex h-full flex-col" data-testid="order-book">
      <header className="grid grid-cols-[1fr_1fr_1.1fr] gap-2 border-b border-border px-3 py-2 text-end text-xs text-muted">
        <span className="text-start">{t.price}</span>
        <span>{t.amount}</span>
        <span>{t.total}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Asks are anchored to the spread (bottom of their half), best ask nearest the spread. */}
        <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
          <Levels levels={asks} side="ask" max={max} scales={scales} onPick={onPick} />
        </div>
        <div className="border-y border-border px-3 py-1.5 text-xs text-muted">
          {t.spread}: <span className="font-mono text-foreground">{spread ?? '—'}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <Levels levels={bids} side="bid" max={max} scales={scales} onPick={onPick} />
        </div>
      </div>
    </section>
  );
}
