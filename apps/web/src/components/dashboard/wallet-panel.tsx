'use client';

import type { BalanceDto, LedgerHistoryItemDto } from '@platform/shared';
import { useEffect, useState } from 'react';
import { errorMessage } from '@/components/auth/shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import type { Dictionary } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Amounts arrive as exact decimal strings and are displayed as-is (never parsed into floats). */
function Amount({ value, className }: { value: string; className?: string }) {
  return (
    <span dir="ltr" className={cn('font-mono tabular-nums', className)}>
      {value}
    </span>
  );
}

export function WalletPanel({ t }: { t: Dictionary }) {
  const d = t.dashboard;
  const [balances, setBalances] = useState<BalanceDto[] | null>(null);
  const [showZero, setShowZero] = useState(false);
  const [items, setItems] = useState<LedgerHistoryItemDto[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fmt = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

  useEffect(() => {
    let active = true;
    api<{ balances: BalanceDto[] }>('/v1/me/balances')
      .then((res) => {
        if (active) setBalances(res.balances);
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(t.auth, err));
      });
    return () => {
      active = false;
    };
  }, [t.auth]);

  useEffect(() => {
    let active = true;
    const query = cursor ? `?limit=20&before=${cursor}` : '?limit=20';
    api<{ items: LedgerHistoryItemDto[]; nextBefore: string | null }>(
      `/v1/me/ledger-entries${query}`,
    )
      .then((res) => {
        if (!active) return;
        setItems((prev) => (cursor ? [...prev, ...res.items] : res.items));
        setNextBefore(res.nextBefore);
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(t.auth, err));
      });
    return () => {
      active = false;
    };
  }, [cursor, t.auth]);

  return (
    <div className="space-y-6">
      {error && <Alert tone="error">{error}</Alert>}
      <Alert tone="warning">{d.depositsNotice}</Alert>

      <Card>
        <CardTitle>{d.balancesTitle}</CardTitle>
        <CardDescription>{d.balancesIntro}</CardDescription>
        <label className="mt-3 flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={showZero}
            onChange={(e) => setShowZero(e.target.checked)}
          />
          {d.showZero}
        </label>
        {balances === null ? (
          <p className="mt-4 text-sm text-muted">{d.loading}</p>
        ) : balances.length === 0 ? (
          <p className="mt-4 text-sm text-muted">{d.noAssets}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="py-2 text-start font-medium">{d.asset}</th>
                  <th className="py-2 text-end font-medium">{d.available}</th>
                  <th className="py-2 text-end font-medium">{d.locked}</th>
                  <th className="py-2 text-end font-medium">{d.margin}</th>
                  <th className="py-2 text-end font-medium">{d.total}</th>
                </tr>
              </thead>
              <tbody>
                {balances
                  .filter((b) => showZero || !/^0(\.0+)?$/.test(b.total))
                  .map((b) => (
                    <tr key={b.asset} className="border-b border-border/60 last:border-0">
                      <td className="py-3">
                        <div className="flex items-baseline gap-2">
                          <span className="font-medium" dir="ltr">
                            {b.asset}
                          </span>
                          <span className="text-xs text-muted">{b.name}</span>
                          {b.paper && <Badge tone="warning">{t.terminal.paper}</Badge>}
                        </div>
                      </td>
                      <td className="py-3 text-end">
                        <Amount value={b.available} />
                      </td>
                      <td className="py-3 text-end">
                        <Amount value={b.locked} className="text-muted" />
                      </td>
                      <td className="py-3 text-end">
                        <Amount value={b.margin} className="text-muted" />
                      </td>
                      <td className="py-3 text-end">
                        <Amount value={b.total} className="font-semibold" />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>{d.historyTitle}</CardTitle>
        {items.length === 0 ? (
          <p className="mt-4 text-sm text-muted">{d.historyEmpty}</p>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {items.map((item) => (
              <li key={item.postingId} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{d.entryTypes[item.entryType]}</p>
                  <p className="text-xs text-muted">
                    {fmt.format(new Date(item.createdAt))} ·{' '}
                    {item.bucket === 'locked'
                      ? d.bucketLocked
                      : item.bucket === 'margin'
                        ? d.bucketMargin
                        : item.bucket === 'withdrawing'
                          ? d.bucketWithdrawing
                          : d.bucketAvailable}
                  </p>
                </div>
                <Amount
                  value={`${item.change} ${item.asset}`}
                  className={item.change.startsWith('-') ? 'text-negative' : 'text-positive'}
                />
              </li>
            ))}
          </ul>
        )}
        {nextBefore && (
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => setCursor(nextBefore)}
          >
            {d.loadMore}
          </Button>
        )}
      </Card>
    </div>
  );
}
