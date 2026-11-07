'use client';

import type { StatementDto } from '@platform/shared';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';

/** The last 12 months and the current and previous year, newest first (UTC). */
function periods(now = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  const y = now.getUTCFullYear();
  return [...out, String(y), String(y - 1)];
}

/** Monthly and annual statements from the ledger (ADR-0028), with a CSV download. */
export function StatementsPanel({ t }: { t: Dictionary }) {
  const s = t.dashboard.statements;
  const options = periods();
  const [period, setPeriod] = useState(options[0]!);
  const [data, setData] = useState<StatementDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api<StatementDto>(`/v1/me/statements?period=${period}`)
      .then((d) => active && setData(d))
      .catch(
        (err: unknown) => active && setError(err instanceof ApiError ? err.message : String(err)),
      );
    return () => {
      active = false;
    };
  }, [period]);

  return (
    <Card className="space-y-4 p-5" data-testid="statements">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <CardTitle>{s.title}</CardTitle>
          <p className="mt-1 text-sm text-muted">{s.intro}</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label={s.period}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={period}
            onChange={(e) => {
              setData(null);
              setError(null);
              setPeriod(e.target.value);
            }}
          >
            {options.map((p) => (
              <option key={p} value={p}>
                {p.length === 4 ? `${s.year} ${p}` : p}
              </option>
            ))}
          </select>
          <Button asChild variant="outline" size="sm">
            <a href={`/api/v1/me/statements.csv?period=${period}`} data-testid="statement-csv">
              {s.downloadCsv}
            </a>
          </Button>
        </div>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {data && data.assets.length === 0 && <p className="text-sm text-muted">{s.empty}</p>}
      {data && data.assets.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="bg-surface text-left text-xs text-muted">
              <tr>
                {[s.asset, s.opening, s.credits, s.debits, s.closing].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.assets.map((a) => (
                <tr key={a.asset} className="border-t border-border font-mono tabular-nums">
                  <td className="px-3 py-2 font-sans font-medium">{a.asset}</td>
                  <td className="px-3 py-2">{a.opening}</td>
                  <td className="px-3 py-2 text-positive">{a.credits}</td>
                  <td className="px-3 py-2 text-negative">{a.debits}</td>
                  <td className="px-3 py-2">{a.closing}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <p className="text-xs text-muted">
          {s.lines.replace('{n}', String(data.lines.length))}
          {data.truncated ? ` ${s.truncated}` : ''} {s.note}
        </p>
      )}
    </Card>
  );
}
