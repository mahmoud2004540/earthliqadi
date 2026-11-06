'use client';

import type { PublicGridDto } from '@platform/shared';
import { useCallback, useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';

function duration(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Grid marketplace (ADR-0025): public grids, ranked by completed rounds, and copying them. */
export function GridMarketplace({ t }: { t: Dictionary }) {
  const g = t.grids;
  const [grids, setGrids] = useState<PublicGridDto[] | null>(null);
  const [size, setSize] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ id: string; tone: 'error' | 'success'; text: string } | null>(
    null,
  );
  const load = useCallback(() => {
    api<{ grids: PublicGridDto[] }>('/v1/grids/public')
      .then((r) => setGrids(r.grids))
      .catch(() => setGrids([]));
  }, []);
  useEffect(load, [load]);

  async function copy(id: string) {
    setMsg(null);
    try {
      await api(`/v1/grids/${id}/copy`, {
        method: 'POST',
        body: { quantityPerGrid: size[id] ?? '' },
      });
      setMsg({ id, tone: 'success', text: g.copied });
      load();
    } catch (err) {
      const text =
        err instanceof ApiError
          ? err.status === 401
            ? g.signIn
            : (err.details?.[0]?.message ?? err.message)
          : String(err);
      setMsg({ id, tone: 'error', text });
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-10 sm:px-6" data-testid="grid-marketplace">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{g.title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted">{g.intro}</p>
      </div>
      {grids && grids.length === 0 && <p className="text-sm text-muted">{g.empty}</p>}
      {grids && grids.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-surface text-left text-xs text-muted">
              <tr>
                {[
                  g.market,
                  g.range,
                  g.grids,
                  g.direction,
                  g.running,
                  g.rounds,
                  g.profit,
                  g.copies,
                  g.status,
                  g.sizePerGrid,
                  '',
                ].map((h, i) => (
                  <th key={i} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grids.map((x) => (
                <tr key={x.id} className="border-t border-border align-top" data-testid="grid-row">
                  <td className="px-3 py-2 font-medium">{x.market}</td>
                  <td className="px-3 py-2 font-mono">
                    {x.lowerPrice}–{x.upperPrice}
                  </td>
                  <td className="px-3 py-2">{x.gridCount}</td>
                  <td className="px-3 py-2">{t.algo.directions[x.direction]}</td>
                  <td className="px-3 py-2">{duration(x.runningSeconds)}</td>
                  <td className="px-3 py-2">{x.completedRounds}</td>
                  <td className="px-3 py-2 font-mono">{x.gridProfit}</td>
                  <td className="px-3 py-2">{x.copies}</td>
                  <td className="px-3 py-2 text-muted">{x.status}</td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label={g.sizePerGrid}
                      className="h-8 w-28 text-xs"
                      inputMode="decimal"
                      placeholder={x.quantityPerGrid}
                      value={size[x.id] ?? ''}
                      onChange={(e) => setSize((p) => ({ ...p, [x.id]: e.target.value.trim() }))}
                      dir="ltr"
                    />
                    {msg?.id === x.id && (
                      <Alert tone={msg.tone} className="mt-2">
                        {msg.text}
                      </Alert>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={x.status !== 'running' || !size[x.id]}
                      onClick={() => void copy(x.id)}
                    >
                      {g.copy}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
