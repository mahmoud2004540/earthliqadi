'use client';

import type { FeeScheduleDto, MarketDto, PointsEntryDto } from '@platform/shared';
import { useEffect, useState } from 'react';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import type { Dictionary } from '@/i18n';
import { api } from '@/lib/api';

/** Live fee schedule (ADR-0018): per-market base fees and the volume tier discounts. */
export function FeeSchedule({ t }: { t: Dictionary }) {
  const f = t.growth;
  const [schedule, setSchedule] = useState<FeeScheduleDto | null>(null);
  const [markets, setMarkets] = useState<MarketDto[]>([]);
  useEffect(() => {
    api<FeeScheduleDto>('/v1/fees/schedule')
      .then(setSchedule)
      .catch(() => setSchedule(null));
    api<{ markets: MarketDto[] }>('/v1/markets')
      .then((r) => setMarkets(r.markets))
      .catch(() => setMarkets([]));
  }, []);
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-12 sm:px-6" data-testid="fee-schedule">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{f.feesTitle}</h1>
        <p className="mt-2 text-sm text-muted">{f.feesIntro}</p>
      </div>
      <Card className="p-6">
        <CardTitle>{f.marketFees}</CardTitle>
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-2">{f.market}</th>
              <th>{f.maker}</th>
              <th>{f.taker}</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => (
              <tr key={m.symbol} className="border-t border-border">
                <td className="py-2">{m.symbol}</td>
                <td className="font-mono">{(m.makerFeeBps / 100).toFixed(2)}%</td>
                <td className="font-mono">{(m.takerFeeBps / 100).toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {schedule && (
        <Card className="p-6">
          <CardTitle>{f.tiers}</CardTitle>
          <CardDescription>
            {f.volumeIn} {schedule.volumeAssets}
          </CardDescription>
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-2">{f.tier}</th>
                <th>{f.minVolume}</th>
                <th>{f.makerDiscount}</th>
                <th>{f.takerDiscount}</th>
              </tr>
            </thead>
            <tbody>
              {schedule.tiers.map((x) => (
                <tr key={x.tier} className="border-t border-border" data-testid="fee-tier">
                  <td className="py-2">{x.tier}</td>
                  <td className="font-mono">{x.minVolume30d}</td>
                  <td className="font-mono">−{(x.makerDiscountBps / 100).toFixed(2)}%</td>
                  <td className="font-mono">−{(x.takerDiscountBps / 100).toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="mt-4 list-disc space-y-1 ps-5 text-xs text-muted">
            {schedule.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            <li>
              {f.referralNote
                .replace('{share}', String(schedule.referralShareBps / 100))
                .replace('{days}', String(schedule.referralDurationDays))}
            </li>
            <li>{f.noDepositFee}</li>
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Public points leaderboard (not a token; derived from real, filtered activity). */
export function Leaderboard({ t }: { t: Dictionary }) {
  const f = t.growth;
  const [data, setData] = useState<{ entries: PointsEntryDto[]; note: string } | null>(null);
  useEffect(() => {
    api<{ entries: PointsEntryDto[]; note: string }>('/v1/points/leaderboard?days=30')
      .then(setData)
      .catch(() => setData(null));
  }, []);
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-12 sm:px-6" data-testid="leaderboard">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{f.leaderboardTitle}</h1>
        <p className="mt-2 text-sm text-muted">{f.leaderboardIntro}</p>
      </div>
      <Card className="p-6">
        {data?.entries.length ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-2">#</th>
                <th>{f.account}</th>
                <th className="text-right">{f.points}</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.rank} className="border-t border-border">
                  <td className="py-2">{e.rank}</td>
                  <td className="font-mono">{e.account}</td>
                  <td className="text-right font-mono">{e.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted">{f.noPoints}</p>
        )}
        <p className="mt-4 text-xs text-muted">{data?.note ?? f.pointsNote}</p>
      </Card>
    </div>
  );
}
