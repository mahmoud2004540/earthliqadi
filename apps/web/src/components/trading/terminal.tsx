'use client';

import {
  CANDLE_INTERVALS,
  type AssetDto,
  type BalanceDto,
  type CandleDto,
  type CandleInterval,
  type MarketDto,
  type OrderBookDto,
  type OrderDto,
  type PublicTradeDto,
  type TickerDto,
  type TradeDto,
  type WsServerMessage,
} from '@platform/shared';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { Dictionary } from '@/i18n';
import { api } from '@/lib/api';
import { useMarketStream, type StreamSubscription } from '@/lib/market-stream';
import { mergeTrades } from '@/lib/trades';
import { cn } from '@/lib/utils';
import { MyOrders } from './my-orders';
import { OrderBook } from './order-book';
import { OrderForm } from './order-form';
import { PriceChart } from './price-chart';
import { RecentTrades } from './recent-trades';

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | null;
  tone?: 'positive' | 'negative';
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd
        className={cn(
          'truncate font-mono text-sm',
          tone === 'positive' && 'text-positive',
          tone === 'negative' && 'text-negative',
        )}
      >
        {value ?? '—'}
      </dd>
    </div>
  );
}

export function Terminal({ symbol, t }: { symbol: string; t: Dictionary }) {
  const tt = t.terminal;
  const [markets, setMarkets] = useState<MarketDto[] | null>(null);
  const [assets, setAssets] = useState<AssetDto[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [book, setBook] = useState<OrderBookDto | null>(null);
  const [trades, setTrades] = useState<PublicTradeDto[]>([]);
  const [ticker, setTicker] = useState<TickerDto | null>(null);
  const [candles, setCandles] = useState<CandleDto[]>([]);
  const [interval, setIntervalValue] = useState<CandleInterval>('1m');
  const [orders, setOrders] = useState<OrderDto[]>([]);
  const [balances, setBalances] = useState<BalanceDto[]>([]);
  const [myTrades, setMyTrades] = useState<TradeDto[]>([]);
  const [price, setPrice] = useState('');
  const [privateVersion, setPrivateVersion] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([
      api<{ markets: MarketDto[] }>('/v1/markets'),
      api<{ assets: AssetDto[] }>('/v1/assets'),
    ])
      .then(([m, a]) => {
        if (!active) return;
        setMarkets(m.markets);
        setAssets(a.assets);
      })
      .catch(() => {
        if (active) setMarkets([]);
      });
    api('/v1/me')
      .then(() => {
        if (active) setSignedIn(true);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const refreshPrivate = useCallback(() => setPrivateVersion((v) => v + 1), []);

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    Promise.all([
      api<{ balances: BalanceDto[] }>('/v1/me/balances'),
      api<{ trades: TradeDto[] }>('/v1/me/trades?limit=50'),
      api<{ orders: OrderDto[] }>(`/v1/orders?market=${symbol}&limit=100`),
    ])
      .then(([b, tr, o]) => {
        if (!active) return;
        setBalances(b.balances);
        setMyTrades(tr.trades.filter((x) => x.market === symbol));
        setOrders(o.orders);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [signedIn, symbol, privateVersion]);

  const subscriptions = useMemo<StreamSubscription[]>(
    () => [
      { channel: 'book', market: symbol },
      { channel: 'trades', market: symbol },
      { channel: 'ticker', market: symbol },
      { channel: 'candles', market: symbol, interval },
      ...(signedIn ? [{ channel: 'orders' as const, market: symbol }] : []),
    ],
    [symbol, interval, signedIn],
  );

  const onMessage = useCallback(
    (m: WsServerMessage) => {
      switch (m.type) {
        case 'book':
          setBook(m.data);
          break;
        case 'ticker':
          setTicker(m.data);
          break;
        case 'candles':
          if (m.interval === interval) setCandles(m.data);
          break;
        case 'trades':
          setTrades((prev) => mergeTrades(m.snapshot ? [] : prev, m.data));
          break;
        case 'orders':
          setOrders((prev) => {
            const byId = new Map(prev.map((o) => [o.id, o]));
            for (const o of m.data as OrderDto[]) byId.set(o.id, o);
            return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          });
          refreshPrivate();
          break;
        default:
          break;
      }
    },
    [interval, refreshPrivate],
  );
  const connection = useMarketStream(subscriptions, onMessage);

  const market = markets?.find((m) => m.symbol === symbol);
  if (markets !== null && !market) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <Alert tone="warning">
          {tt.noMarkets}{' '}
          <Link href="/markets" className="underline">
            {tt.marketsTitle}
          </Link>
        </Alert>
      </div>
    );
  }
  const scale = (code: string | undefined) => assets.find((a) => a.code === code)?.scale ?? 0;
  const scales = { base: scale(market?.base), quote: scale(market?.quote) };
  const dataState = ticker?.status.state ?? book?.status.state;
  const change = ticker?.change24hPct ?? null;

  return (
    <div className="mx-auto max-w-[1600px] px-2 py-3 sm:px-4" data-testid="terminal">
      {connection !== 'open' && (
        <Alert tone="warning" className="mb-2" data-testid="stream-status">
          {connection === 'connecting' ? tt.connection.connecting : tt.connection.disconnected}
        </Alert>
      )}
      {connection === 'open' && dataState && dataState !== 'live' && (
        <Alert tone="warning" className="mb-2" data-testid="stream-status">
          {dataState === 'halted' ? tt.connection.halted : tt.connection.delayed}
        </Alert>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-x-8 gap-y-2 rounded-lg border border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-3">
          <select
            aria-label={tt.market}
            value={symbol}
            onChange={(e) => window.location.assign(`/trade/${e.target.value}`)}
            className="rounded-md border border-border bg-background px-2 py-1 font-semibold"
          >
            {(markets ?? [{ symbol } as MarketDto]).map((m) => (
              <option key={m.symbol} value={m.symbol}>
                {m.symbol.replace('-', ' / ')}
              </option>
            ))}
          </select>
          {market?.paper && (
            <Badge tone="warning" data-testid="paper-badge">
              {tt.paper}
            </Badge>
          )}
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <span
              aria-hidden
              className={cn(
                'size-2 rounded-full',
                connection === 'open' && dataState === 'live' ? 'bg-positive' : 'bg-warning',
              )}
            />
            {connection === 'open' && dataState === 'live' ? tt.connection.live : '—'}
          </span>
        </div>
        <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-5" data-testid="ticker">
          <Stat label={tt.last} value={ticker?.last ?? null} />
          <Stat
            label={tt.change24h}
            value={change === null ? null : `${change}%`}
            tone={change === null ? undefined : change.startsWith('-') ? 'negative' : 'positive'}
          />
          <Stat label={tt.high24h} value={ticker?.high24h ?? null} />
          <Stat label={tt.low24h} value={ticker?.low24h ?? null} />
          <Stat
            label={`${tt.volume24h} (${market?.base ?? ''})`}
            value={ticker?.volume24h ?? null}
          />
        </dl>
      </div>

      <div className="grid gap-2 lg:grid-cols-[1fr_300px_320px]">
        <section className="flex min-h-[420px] flex-col rounded-lg border border-border bg-surface">
          <div className="flex gap-1 border-b border-border px-3 py-2">
            {CANDLE_INTERVALS.map((iv) => (
              <button
                key={iv}
                type="button"
                onClick={() => {
                  setIntervalValue(iv);
                  setCandles([]);
                }}
                className={cn(
                  'rounded px-2 py-0.5 text-xs',
                  interval === iv ? 'bg-surface-raised text-foreground' : 'text-muted',
                )}
              >
                {iv}
              </button>
            ))}
          </div>
          <div className="flex-1">
            <PriceChart candles={candles} emptyLabel={tt.noTradesYet} />
          </div>
        </section>
        <div className="grid min-h-[420px] grid-rows-[3fr_2fr] gap-2">
          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <OrderBook book={book} t={tt} scales={scales} onPick={setPrice} />
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <RecentTrades trades={trades} t={tt} />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface">
          {market && (
            <OrderForm
              market={market}
              scales={scales}
              balances={balances}
              signedIn={signedIn}
              disabled={market.status !== 'ACTIVE'}
              price={price}
              onPriceChange={setPrice}
              onPlaced={refreshPrivate}
              t={t}
            />
          )}
        </div>
      </div>

      {signedIn && (
        <div className="mt-2 min-h-[220px] rounded-lg border border-border bg-surface">
          <MyOrders orders={orders} trades={myTrades} t={tt} onChanged={refreshPrivate} />
        </div>
      )}
    </div>
  );
}
