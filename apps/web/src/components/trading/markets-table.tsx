'use client';

import type { TickerDto } from '@platform/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Dictionary } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Real markets and statistics only; an empty list is shown as empty. */
export function MarketsTable({ t }: { t: Dictionary['terminal'] }) {
  const [tickers, setTickers] = useState<TickerDto[] | null>(null);

  useEffect(() => {
    let active = true;
    const load = () =>
      api<{ tickers: TickerDto[] }>('/v1/markets/tickers')
        .then((r) => {
          if (active) setTickers(r.tickers);
        })
        .catch(() => {
          if (active) setTickers([]);
        });
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  if (tickers === null) return <p className="text-sm text-muted">…</p>;
  if (tickers.length === 0) return <p className="text-sm text-muted">{t.noMarkets}</p>;

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[640px] text-sm" data-testid="markets-table">
        <thead className="bg-surface text-muted">
          <tr>
            {[t.market, t.last, t.change24h, t.high24h, t.low24h, t.volume24h, ''].map((h, i) => (
              <th key={`${h}-${i}`} className="px-4 py-3 text-start font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tickers.map((tk) => (
            <tr key={tk.market} className="border-t border-border">
              <td className="px-4 py-3 font-semibold">{tk.market.replace('-', ' / ')}</td>
              <td className="px-4 font-mono">{tk.last ?? '—'}</td>
              <td
                className={cn(
                  'px-4 font-mono',
                  tk.change24hPct?.startsWith('-')
                    ? 'text-negative'
                    : tk.change24hPct
                      ? 'text-positive'
                      : '',
                )}
              >
                {tk.change24hPct ? `${tk.change24hPct}%` : '—'}
              </td>
              <td className="px-4 font-mono">{tk.high24h ?? '—'}</td>
              <td className="px-4 font-mono">{tk.low24h ?? '—'}</td>
              <td className="px-4 font-mono">{tk.volume24h}</td>
              <td className="px-4 text-end">
                <Button asChild size="sm" variant="outline">
                  <Link href={`/trade/${tk.market}`}>{t.trade}</Link>
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
