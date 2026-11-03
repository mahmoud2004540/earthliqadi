'use client';

import type { PublicTradeDto } from '@platform/shared';
import type { Dictionary } from '@/i18n';
import { cn } from '@/lib/utils';

export function RecentTrades({
  trades,
  t,
}: {
  trades: PublicTradeDto[];
  t: Dictionary['terminal'];
}) {
  const fmt = new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return (
    <section
      aria-label={t.recentTrades}
      className="flex h-full flex-col"
      data-testid="recent-trades"
    >
      <header className="grid grid-cols-3 border-b border-border px-3 py-2 text-end text-xs text-muted">
        <span className="text-start">{t.price}</span>
        <span>{t.amount}</span>
        <span>{t.time}</span>
      </header>
      {trades.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted">{t.noTradesYet}</p>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {trades.map((tr) => (
            <li
              key={tr.seq}
              className="grid grid-cols-3 px-3 py-0.5 text-end font-mono text-xs tabular-nums"
            >
              <span
                className={cn(
                  'text-start',
                  tr.takerSide === 'buy' ? 'text-positive' : 'text-negative',
                )}
              >
                {tr.price}
              </span>
              <span>{tr.quantity}</span>
              <span className="text-muted">{fmt.format(new Date(tr.executedAt))}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
