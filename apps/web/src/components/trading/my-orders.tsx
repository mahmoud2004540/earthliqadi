'use client';

import type { OrderDto, TradeDto } from '@platform/shared';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Dictionary } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const OPEN = new Set(['pending_new', 'pending_trigger', 'open', 'partially_filled']);

function statusTone(status: string): 'positive' | 'negative' | 'info' | 'neutral' | 'warning' {
  if (status === 'filled') return 'positive';
  if (status === 'rejected') return 'negative';
  if (status === 'cancelled') return 'neutral';
  if (status === 'pending_new' || status === 'pending_trigger') return 'warning';
  return 'info';
}

export function MyOrders({
  orders,
  trades,
  t,
  onChanged,
}: {
  orders: OrderDto[];
  trades: TradeDto[];
  t: Dictionary['terminal'];
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'open' | 'history' | 'trades'>('open');
  const fmt = new Intl.DateTimeFormat('en', {
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false,
  });
  const visible = orders.filter((o) => (tab === 'open' ? OPEN.has(o.status) : !OPEN.has(o.status)));

  async function cancel(id: string) {
    await api(`/v1/orders/${id}`, { method: 'DELETE' }).catch(() => undefined);
    onChanged();
  }

  const tabs: ['open' | 'history' | 'trades', string][] = [
    ['open', `${t.openOrders} (${orders.filter((o) => OPEN.has(o.status)).length})`],
    ['history', t.orderHistory],
    ['trades', t.myTrades],
  ];

  return (
    <section className="flex h-full flex-col" data-testid="my-orders">
      <div role="tablist" className="flex gap-4 border-b border-border px-4">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              '-mb-px border-b-2 py-2 text-sm',
              tab === key ? 'border-primary text-foreground' : 'border-transparent text-muted',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {tab === 'trades' ? (
          trades.length === 0 ? (
            <p className="p-4 text-sm text-muted">{t.noOrders}</p>
          ) : (
            <table className="w-full min-w-[640px] text-xs">
              <thead className="text-muted">
                <tr>
                  {[t.time, t.side, t.price, t.amount, t.total, t.fee].map((h) => (
                    <th key={h} className="px-4 py-2 text-start font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono">
                {trades.map((tr) => (
                  <tr key={tr.id} className="border-t border-border/60">
                    <td className="px-4 py-1.5">{fmt.format(new Date(tr.createdAt))}</td>
                    <td
                      className={cn('px-4', tr.side === 'buy' ? 'text-positive' : 'text-negative')}
                    >
                      {tr.side} · {tr.liquidity}
                    </td>
                    <td className="px-4">{tr.price}</td>
                    <td className="px-4">{tr.quantity}</td>
                    <td className="px-4">{tr.quoteAmount}</td>
                    <td className="px-4">
                      {tr.fee} {tr.feeAsset}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : visible.length === 0 ? (
          <p className="p-4 text-sm text-muted">{t.noOrders}</p>
        ) : (
          <table className="w-full min-w-[720px] text-xs">
            <thead className="text-muted">
              <tr>
                {[t.time, t.side, t.type, t.price, t.amount, t.filled, t.status, ''].map((h, i) => (
                  <th key={`${h}-${i}`} className="px-4 py-2 text-start font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((o) => (
                <tr key={o.id} className="border-t border-border/60" data-testid="order-row">
                  <td className="px-4 py-1.5 font-mono">{fmt.format(new Date(o.createdAt))}</td>
                  <td className={cn('px-4', o.side === 'buy' ? 'text-positive' : 'text-negative')}>
                    {o.side}
                  </td>
                  <td className="px-4">{o.type.replace('_', ' ')}</td>
                  <td className="px-4 font-mono">{o.price ?? '—'}</td>
                  <td className="px-4 font-mono">{o.quantity}</td>
                  <td className="px-4 font-mono">{o.filledQuantity}</td>
                  <td className="px-4">
                    <Badge tone={statusTone(o.status)}>{o.status.replace('_', ' ')}</Badge>
                    {o.cancelReason && o.cancelReason !== 'user' && (
                      <span className="ms-2 text-muted">
                        ({o.cancelReason.replaceAll('_', ' ')})
                      </span>
                    )}
                  </td>
                  <td className="px-4 text-end">
                    {OPEN.has(o.status) &&
                      (o.cancelRequested ? (
                        <span className="text-muted">{t.cancelRequested}</span>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => void cancel(o.id)}>
                          {t.cancel}
                        </Button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
