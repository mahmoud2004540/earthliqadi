'use client';

import type { AlgoOrderDto, MarketDto } from '@platform/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';

type Kind = 'twap' | 'iceberg' | 'trailing' | 'chase' | 'scale' | 'grid';
const KINDS: Kind[] = ['twap', 'iceberg', 'trailing', 'chase', 'scale', 'grid'];

/** Percent text ("1.5") to basis points (150); NaN when invalid. */
function bps(percent: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(percent)) return NaN;
  return Math.round(Number(percent) * 100);
}

/**
 * Advanced orders (ADR-0020, ADR-0025): TWAP, iceberg, trailing stop, chase,
 * scaled orders and grid bots. Every child is an ordinary order with its own
 * funds check; the server enforces everything shown here.
 */
export function AlgoPanel({ market, t }: { market: MarketDto; t: Dictionary }) {
  const a = t.algo;
  const perp = market.kind === 'perpetual';
  const [kind, setKind] = useState<Kind>('twap');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [f, setF] = useState<Record<string, string>>({
    interval: '60',
    callback: '1',
    slippage: '1',
    count: '5',
    distribution: 'flat',
    gridCount: '10',
    direction: 'long',
  });
  const [flags, setFlags] = useState({ hidden: false, isPublic: false });
  const [list, setList] = useState<AlgoOrderDto[]>([]);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const set = (k: string) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const load = useCallback(() => {
    api<{ algoOrders: AlgoOrderDto[] }>('/v1/algo-orders')
      .then((r) => setList(r.algoOrders.filter((x) => x.market === market.symbol).slice(0, 6)))
      .catch(() => setList([]));
  }, [market.symbol]);
  useEffect(load, [load]);

  function body(): { path: string; body: Record<string, unknown> } {
    const m = market.symbol;
    switch (kind) {
      case 'twap':
      case 'iceberg':
        return {
          path: '/v1/algo-orders',
          body: {
            market: m,
            kind,
            side,
            quantity: f.quantity,
            sliceQuantity: f.slice,
            price: f.price,
            ...(kind === 'twap' ? { intervalSeconds: Number(f.interval) } : {}),
          },
        };
      case 'trailing':
        return {
          path: '/v1/algo-orders',
          body: {
            market: m,
            kind,
            side,
            quantity: f.quantity,
            callbackBps: bps(f.callback ?? ''),
            slippageBps: bps(f.slippage ?? ''),
            ...(f.activation ? { activationPrice: f.activation } : {}),
          },
        };
      case 'chase':
        return {
          path: '/v1/algo-orders',
          body: { market: m, kind, side, quantity: f.quantity, price: f.price },
        };
      case 'scale':
        return {
          path: '/v1/orders/scale',
          body: {
            market: m,
            clientOrderIdPrefix: `scale-${crypto.randomUUID().slice(0, 18)}`,
            side,
            quantity: f.quantity,
            startPrice: f.start,
            endPrice: f.end,
            count: Number(f.count),
            distribution: f.distribution,
            ...(flags.hidden ? { hidden: true } : {}),
          },
        };
      case 'grid':
        return {
          path: '/v1/algo-orders',
          body: {
            market: m,
            kind,
            lowerPrice: f.lower,
            upperPrice: f.upper,
            gridCount: Number(f.gridCount),
            quantityPerGrid: f.perGrid,
            direction: perp ? f.direction : 'long',
            isPublic: flags.isPublic,
          },
        };
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const req = body();
      const res = await api<{ results?: { status: number; error?: { message: string } }[] }>(
        req.path,
        { method: 'POST', body: req.body },
      );
      const failed = res.results?.filter((r) => r.status >= 400) ?? [];
      setMsg(
        failed.length > 0
          ? { tone: 'error', text: `${a.someFailed} ${failed[0]!.error?.message ?? ''}` }
          : { tone: 'success', text: kind === 'scale' ? a.placed : a.started },
      );
      load();
    } catch (err) {
      setMsg({
        tone: 'error',
        text: err instanceof ApiError ? (err.details?.[0]?.message ?? err.message) : String(err),
      });
    }
  }

  async function togglePublic(x: AlgoOrderDto) {
    await api(`/v1/algo-orders/${x.id}/visibility`, {
      method: 'POST',
      body: { isPublic: !x.grid?.isPublic },
    }).then(load, load);
  }

  const fields: [string, string, boolean][] = {
    twap: [
      ['quantity', a.total, true],
      ['slice', a.slice, true],
      ['price', a.worstPrice, true],
      ['interval', a.interval, true],
    ],
    iceberg: [
      ['quantity', a.total, true],
      ['slice', a.visible, true],
      ['price', a.limitPrice, true],
    ],
    trailing: [
      ['quantity', a.total, true],
      ['callback', a.callback, true],
      ['activation', a.activation, false],
      ['slippage', a.slippage, true],
    ],
    chase: [
      ['quantity', a.total, true],
      ['price', a.chaseCap, true],
    ],
    scale: [
      ['quantity', a.total, true],
      ['count', a.count, true],
      ['start', a.startPrice, true],
      ['end', a.endPrice, true],
    ],
    grid: [
      ['lower', a.lower, true],
      ['upper', a.upper, true],
      ['gridCount', a.grids, true],
      ['perGrid', a.perGrid, true],
    ],
  }[kind] as [string, string, boolean][];

  return (
    <div className="space-y-3 border-t border-border p-3" data-testid="algo-panel">
      <h3 className="text-sm font-medium">{a.title}</h3>
      <p className="text-[11px] text-muted" data-testid="algo-help">
        {a.help[kind]}
      </p>
      <form onSubmit={(e) => void submit(e)} className="grid grid-cols-2 gap-2 text-xs">
        <select
          aria-label={a.kind}
          className="h-8 rounded-md border border-border bg-background px-2"
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind)}
          data-testid="algo-kind"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {a.kinds[k]}
            </option>
          ))}
        </select>
        {kind === 'grid' ? (
          <select
            aria-label={a.direction}
            className="h-8 rounded-md border border-border bg-background px-2"
            value={perp ? f.direction : 'long'}
            onChange={(e) => set('direction')(e.target.value)}
            disabled={!perp}
          >
            <option value="long">{a.directions.long}</option>
            {perp && <option value="short">{a.directions.short}</option>}
            {perp && <option value="neutral">{a.directions.neutral}</option>}
          </select>
        ) : (
          <select
            aria-label={a.side}
            className="h-8 rounded-md border border-border bg-background px-2"
            value={side}
            onChange={(e) => setSide(e.target.value as 'buy' | 'sell')}
          >
            <option value="buy">{t.terminal.buy}</option>
            <option value="sell">{t.terminal.sell}</option>
          </select>
        )}
        {fields.map(([key, label, required]) => (
          <div key={key}>
            <Label htmlFor={`algo-${key}`}>{label}</Label>
            <Input
              id={`algo-${key}`}
              className="h-8 text-xs"
              inputMode="decimal"
              value={f[key] ?? ''}
              onChange={(e) => set(key)(e.target.value.trim())}
              required={required}
              dir="ltr"
            />
          </div>
        ))}
        {kind === 'scale' && (
          <>
            <select
              aria-label={a.distribution}
              className="h-8 rounded-md border border-border bg-background px-2"
              value={f.distribution}
              onChange={(e) => set('distribution')(e.target.value)}
            >
              <option value="flat">{a.distributions.flat}</option>
              <option value="increasing">{a.distributions.increasing}</option>
              <option value="decreasing">{a.distributions.decreasing}</option>
            </select>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={flags.hidden}
                onChange={(e) => setFlags((p) => ({ ...p, hidden: e.target.checked }))}
              />
              {t.terminal.hidden}
            </label>
          </>
        )}
        {kind === 'grid' && (
          <label className="col-span-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={flags.isPublic}
              onChange={(e) => setFlags((p) => ({ ...p, isPublic: e.target.checked }))}
            />
            {a.listPublic}
          </label>
        )}
        <div className="col-span-2">
          <Button type="submit" size="sm" variant="outline" className="w-full">
            {kind === 'scale' ? a.place : a.start}
          </Button>
        </div>
      </form>
      {kind === 'grid' && (
        <Link href="/grids" className="block text-[11px] underline">
          {a.marketplaceLink}
        </Link>
      )}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {list.map((x) => (
        <div key={x.id} className="space-y-0.5 text-[11px]" data-testid="algo-row">
          <div className="flex justify-between gap-2">
            <span>
              {a.kinds[x.kind]} {x.side === 'both' ? '' : x.side}{' '}
              {x.kind === 'grid' ? '' : `${x.filledQuantity}/${x.quantity}`}
            </span>
            <span className="text-muted">{x.status}</span>
            {x.status === 'running' && (
              <button
                type="button"
                className="text-negative"
                onClick={() =>
                  void api(`/v1/algo-orders/${x.id}`, { method: 'DELETE' }).then(load, load)
                }
              >
                {a.stop}
              </button>
            )}
          </div>
          {x.trailing && (
            <div className="text-muted">
              {x.trailing.activated
                ? `${a.firesAt} ${x.trailing.triggerPrice ?? '—'}`
                : `${a.waitingFor} ${x.trailing.activationPrice}`}
            </div>
          )}
          {x.grid && (
            <div className="flex justify-between gap-2 text-muted">
              <span>
                {x.grid.lowerPrice}–{x.grid.upperPrice} · {x.grid.gridCount} · {a.rounds}{' '}
                {x.grid.completedRounds} · {a.profit} {x.grid.gridProfit} {market.quote}
              </span>
              <button type="button" className="underline" onClick={() => void togglePublic(x)}>
                {x.grid.isPublic ? a.unlist : a.list}
              </button>
            </div>
          )}
          {x.lastError && <div className="text-negative">{x.lastError}</div>}
        </div>
      ))}
    </div>
  );
}
