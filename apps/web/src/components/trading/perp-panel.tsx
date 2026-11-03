'use client';

import type { MarketDto, PerpStatsDto, PositionDto } from '@platform/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/utils';

type Tp = Dictionary['terminal']['perp'];

/** Polls mark/index/funding for a perpetual market (REST; updates every 2 s). */
export function usePerpStats(symbol: string, enabled: boolean): PerpStatsDto | null {
  const [stats, setStats] = useState<PerpStatsDto | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = () =>
      api<PerpStatsDto>(`/v1/perp/markets/${symbol}/stats`)
        .then((s) => active && setStats(s))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [symbol, enabled]);
  return stats;
}

function countdown(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${hh > 0 ? `${hh}:` : ''}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function PerpStatsStrip({ stats, tp }: { stats: PerpStatsDto | null; tp: Tp }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const rate = stats?.predictedFundingRate ?? null;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4" data-testid="perp-stats">
      {(
        [
          [tp.mark, stats?.markPrice ?? null, 'perp-mark'],
          [tp.index, stats?.indexPrice ?? null, 'perp-index'],
          [tp.funding, rate === null ? null : `${rate}%`, 'perp-funding'],
          [tp.nextFunding, countdown(stats?.nextFundingAt ?? null, now), 'perp-next-funding'],
        ] as const
      ).map(([label, value, id]) => (
        <div key={id} className="min-w-0">
          <dt className="text-[11px] text-muted">{label}</dt>
          <dd
            className={cn(
              'truncate font-mono text-sm',
              id === 'perp-funding' && rate?.startsWith('-') && 'text-negative',
            )}
            data-testid={id}
          >
            {value ?? '—'}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function pnlTone(v: string | null): string | undefined {
  if (!v || v === '0') return undefined;
  return v.startsWith('-') ? 'text-negative' : 'text-positive';
}

export function PositionsPanel({
  positions,
  market,
  tp,
  onChanged,
}: {
  positions: PositionDto[];
  market: MarketDto;
  tp: Tp;
  onChanged: () => void;
}) {
  const open = positions.filter((p) => p.side !== 'flat');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  async function addMargin(event: FormEvent, symbol: string) {
    event.preventDefault();
    setMessage(null);
    try {
      await api('/v1/perp/margin', { method: 'POST', body: { market: symbol, amount } });
      setAmount('');
      setMessage({ tone: 'success', text: tp.marginAdded });
      onChanged();
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return (
    <div className="p-3" data-testid="positions">
      <h2 className="mb-2 text-sm font-medium">{tp.positions}</h2>
      {open.length === 0 ? (
        <p className="text-sm text-muted">{tp.noPositions}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-xs">
            <thead>
              <tr className="border-b border-border text-muted">
                {[
                  'Market',
                  tp.size,
                  tp.entry,
                  tp.mark.replace(' price', ''),
                  tp.liqPrice,
                  tp.margin,
                  tp.upnl,
                  tp.realized,
                  tp.fundingPnl,
                  tp.addMargin,
                ].map((h) => (
                  <th key={h} className="py-1.5 text-start font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {open.map((p) => (
                <tr
                  key={p.market}
                  className="border-b border-border/60 last:border-0"
                  data-testid="position-row"
                >
                  <td className="py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{p.market}</span>
                      <Badge tone={p.side === 'long' ? 'positive' : 'negative'}>
                        {p.side} {p.leverage}x
                      </Badge>
                      {p.status === 'liquidating' && <Badge tone="warning">{tp.liquidating}</Badge>}
                    </div>
                  </td>
                  <td className="font-mono">{p.size}</td>
                  <td className="font-mono">{p.entryPrice ?? '—'}</td>
                  <td className="font-mono">{p.markPrice ?? '—'}</td>
                  <td className="font-mono text-warning">{p.liquidationPrice ?? '—'}</td>
                  <td className="font-mono">
                    {p.margin} {p.asset}
                  </td>
                  <td className={cn('font-mono', pnlTone(p.unrealizedPnl))}>
                    {p.unrealizedPnl ?? '—'}
                  </td>
                  <td className={cn('font-mono', pnlTone(p.realizedPnl))}>{p.realizedPnl}</td>
                  <td className={cn('font-mono', pnlTone(p.fundingPnl))}>{p.fundingPnl}</td>
                  <td>
                    {p.market === market.symbol && (
                      <form className="flex gap-1" onSubmit={(e) => void addMargin(e, p.market)}>
                        <Input
                          aria-label={tp.addMargin}
                          inputMode="decimal"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value.trim())}
                          className="h-7 w-24 text-xs"
                          dir="ltr"
                        />
                        <Button type="submit" size="sm" variant="outline" disabled={!amount}>
                          {tp.add}
                        </Button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {message && (
        <Alert tone={message.tone} className="mt-2">
          {message.text}
        </Alert>
      )}
    </div>
  );
}
