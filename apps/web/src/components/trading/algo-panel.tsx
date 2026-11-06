'use client';

import type { AlgoOrderDto, MarketDto } from '@platform/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';

/** TWAP and iceberg orders for size (ADR-0020). */
export function AlgoPanel({ market, t }: { market: MarketDto; t: Dictionary }) {
  const a = t.algo;
  const [kind, setKind] = useState<'twap' | 'iceberg'>('twap');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [quantity, setQuantity] = useState('');
  const [slice, setSlice] = useState('');
  const [price, setPrice] = useState('');
  const [interval, setIntervalS] = useState('60');
  const [list, setList] = useState<AlgoOrderDto[]>([]);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const load = useCallback(() => {
    api<{ algoOrders: AlgoOrderDto[] }>('/v1/algo-orders')
      .then((r) => setList(r.algoOrders.filter((x) => x.market === market.symbol).slice(0, 5)))
      .catch(() => setList([]));
  }, [market.symbol]);
  useEffect(load, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/v1/algo-orders', {
        method: 'POST',
        body: {
          market: market.symbol,
          kind,
          side,
          quantity,
          sliceQuantity: slice,
          price,
          ...(kind === 'twap' ? { intervalSeconds: Number(interval) } : {}),
        },
      });
      setMsg({ tone: 'success', text: a.started });
      load();
    } catch (err) {
      setMsg({
        tone: 'error',
        text: err instanceof ApiError ? (err.details?.[0]?.message ?? err.message) : String(err),
      });
    }
  }

  return (
    <div className="space-y-3 border-t border-border p-3" data-testid="algo-panel">
      <h3 className="text-sm font-medium">{a.title}</h3>
      <p className="text-[11px] text-muted">{kind === 'twap' ? a.twapHelp : a.icebergHelp}</p>
      <form onSubmit={(e) => void submit(e)} className="grid grid-cols-2 gap-2 text-xs">
        <select
          aria-label={a.kind}
          className="h-8 rounded-md border border-border bg-background px-2"
          value={kind}
          onChange={(e) => setKind(e.target.value as 'twap' | 'iceberg')}
        >
          <option value="twap">TWAP</option>
          <option value="iceberg">Iceberg</option>
        </select>
        <select
          aria-label={a.side}
          className="h-8 rounded-md border border-border bg-background px-2"
          value={side}
          onChange={(e) => setSide(e.target.value as 'buy' | 'sell')}
        >
          <option value="buy">{t.terminal.buy}</option>
          <option value="sell">{t.terminal.sell}</option>
        </select>
        {(
          [
            ['algo-qty', a.total, quantity, setQuantity],
            ['algo-slice', kind === 'twap' ? a.slice : a.visible, slice, setSlice],
            ['algo-price', kind === 'twap' ? a.worstPrice : a.limitPrice, price, setPrice],
            ...(kind === 'twap' ? [['algo-int', a.interval, interval, setIntervalS] as const] : []),
          ] as const
        ).map(([id, label, value, set]) => (
          <div key={id}>
            <Label htmlFor={id}>{label}</Label>
            <Input
              id={id}
              className="h-8 text-xs"
              inputMode="decimal"
              value={value}
              onChange={(e) => set(e.target.value.trim())}
              required
            />
          </div>
        ))}
        <div className="col-span-2">
          <Button type="submit" size="sm" variant="outline" className="w-full">
            {a.start}
          </Button>
        </div>
      </form>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {list.map((x) => (
        <div key={x.id} className="flex justify-between text-[11px]" data-testid="algo-row">
          <span>
            {x.kind.toUpperCase()} {x.side} {x.filledQuantity}/{x.quantity}
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
      ))}
    </div>
  );
}
