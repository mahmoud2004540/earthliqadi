'use client';

import type { AccountOverviewDto } from '@platform/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { Dictionary } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Trims trailing zeros of a decimal string for display ("3.50000000" → "3.5"). */
function trim(v: string): string {
  return v.includes('.') ? v.replace(/\.?0+$/, '') : v;
}

/** Groups thousands for display without changing digits ("12345.6" → "12,345.6"). */
function group(v: string): string {
  const neg = v.startsWith('-');
  const [whole, frac] = (neg ? v.slice(1) : v).split('.');
  const w = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${w}${frac ? `.${frac}` : ''}`;
}

/**
 * Account overview (ADR-0028): the total first, then every balance with
 * where it is held. Values are indicative (last traded price), and assets
 * without a price are listed, never estimated.
 */
export function AccountOverview({ t }: { t: Dictionary }) {
  const o = t.dashboard.accountOverview;
  const [data, setData] = useState<AccountOverviewDto | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    api<AccountOverviewDto>('/v1/me/overview')
      .then((d) => active && setData(d))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, []);

  if (failed) return <p className="text-sm text-muted">{o.unavailable}</p>;
  if (!data) return <p className="text-sm text-muted">{t.dashboard.loading}</p>;
  const time = new Intl.DateTimeFormat('en', { timeStyle: 'short' }).format(new Date(data.asOf));
  const pnl = data.unrealizedPnl;

  return (
    <section className="space-y-4" data-testid="account-overview">
      <Card className="p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm text-muted">{o.totalValue}</p>
            <p
              className="mt-1 font-mono text-3xl font-semibold tabular-nums"
              data-testid="total-value"
            >
              {data.totalValue === null ? '—' : group(trim(data.totalValue))}{' '}
              <span className="text-base text-muted">{data.valuationAsset ?? ''}</span>
            </p>
            <p className="mt-1 text-xs text-muted">
              {data.valuationAsset
                ? `${o.valuedAt.replace('{asset}', data.valuationAsset)} · ${o.asOf} ${time}`
                : o.noValuationAsset}
            </p>
          </div>
          {pnl !== null && pnl !== '0' && (
            <div className="text-right">
              <p className="text-sm text-muted">{o.unrealizedPnl}</p>
              <p
                className={cn(
                  'font-mono text-lg tabular-nums',
                  pnl.startsWith('-') ? 'text-negative' : 'text-positive',
                )}
              >
                {group(trim(pnl))} {data.valuationAsset}
              </p>
            </div>
          )}
        </div>
        {data.unvalued.length > 0 && (
          <p className="mt-3 text-xs text-warning" data-testid="unvalued">
            {o.unvaluedNote.replace('{assets}', data.unvalued.join(', '))}
          </p>
        )}
      </Card>

      {data.assets.length === 0 ? (
        <Card className="p-5 text-sm text-muted">{o.empty}</Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-surface text-left text-xs text-muted">
              <tr>
                {[
                  o.asset,
                  o.heldIn,
                  o.total,
                  o.available,
                  o.inOrders,
                  o.margin,
                  o.price,
                  o.value,
                ].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.assets.map((a) => (
                <tr key={a.asset} className="border-t border-border" data-testid="overview-row">
                  <td className="px-3 py-2">
                    <span className="font-medium">{a.asset}</span>
                    <span className="block text-xs text-muted">{a.name}</span>
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      tone={a.custody === 'vault' ? 'positive' : 'info'}
                      title={a.custody === 'vault' ? o.vaultHelp : o.ledgerHelp}
                    >
                      {a.custody === 'vault' ? o.vault : o.ledger}
                    </Badge>
                  </td>
                  {[a.total, a.available, a.locked, a.margin].map((v, i) => (
                    <td key={i} className="px-3 py-2 font-mono tabular-nums">
                      {group(trim(v))}
                    </td>
                  ))}
                  <td
                    className="px-3 py-2 font-mono tabular-nums"
                    title={a.priceMarket ?? undefined}
                  >
                    {a.price === null ? '—' : group(trim(a.price))}
                  </td>
                  <td className="px-3 py-2 font-mono tabular-nums">
                    {a.value === null ? o.noPrice : group(trim(a.value))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted" data-testid="balance-disclosure">
        {o.disclosure}{' '}
        <Link href="/terms" className="underline">
          {o.readTerms}
        </Link>
      </p>
    </section>
  );
}
