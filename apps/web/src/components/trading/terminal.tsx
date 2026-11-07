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
  type PositionDto,
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
import { AlgoPanel } from './algo-panel';
import { OrderForm } from './order-form';
import { PerpStatsStrip, PositionsPanel, usePerpStats } from './perp-panel';
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
  const [positions, setPositions] = useState<PositionDto[]>([]);
  const [bookTab, setBookTab] = useState<'book' | 'trades'>('book');
  const [accountTab, setAccountTab] = useState<'positions' | 'orders'>('positions');
  const isPerp = symbol.endsWith('-PERP');
  const perpStats = usePerpStats(symbol, isPerp);

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

  // Positions (perpetuals): refreshed on private updates and every 3 s for mark-to-market.
  useEffect(() => {
    if (!signedIn || !isPerp) return;
    let active = true;
    const load = () =>
      api<{ positions: PositionDto[] }>('/v1/perp/positions')
        .then((r) => active && setPositions(r.positions))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [signedIn, isPerp, privateVersion]);

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

  const openPositions = positions.filter((p) => p.side !== 'flat').length;
  const openOrders = orders.filter((o) =>
    ['PENDING_NEW', 'OPEN', 'PARTIALLY_FILLED', 'PENDING_TRIGGER'].includes(o.status.toUpperCase()),
  ).length;

  return (
    <div className="w-full px-2 py-2" data-testid="terminal">
      {connection !== 'open' && (
        <Alert tone="warning" className="mb-2 py-2" data-testid="stream-status">
          {connection === 'connecting' ? tt.connection.connecting : tt.connection.disconnected}
        </Alert>
      )}
      {isPerp && perpStats?.indexStale && (
        <Alert tone="warning" className="mb-2 py-2" data-testid="perp-index-stale">
          {tt.perp.indexStale}
        </Alert>
      )}
      {connection === 'open' && dataState && dataState !== 'live' && (
        <Alert tone="warning" className="mb-2 py-2" data-testid="stream-status">
          {dataState === 'halted' ? tt.connection.halted : tt.connection.delayed}
        </Alert>
      )}

      {/* Market header: one dense row, as on professional terminals. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-border bg-surface px-3 py-2">
        <div className="flex items-center gap-2">
          <select
            aria-label={tt.market}
            value={symbol}
            onChange={(e) => window.location.assign(`/trade/${e.target.value}`)}
            className="rounded-md border border-border bg-background px-2 py-1 text-base font-semibold"
          >
            {(markets ?? [{ symbol } as MarketDto]).map((m) => (
              <option key={m.symbol} value={m.symbol}>
                {m.symbol.replace('-', ' / ').replace('-PERP', ' Perp')}
              </option>
            ))}
          </select>
          {market?.kind === 'perpetual' && (
            <Badge tone="info" data-testid="perp-badge">
              {market.perp ? `${market.perp.maxLeverage}x` : tt.perp.badge}
            </Badge>
          )}
          {market?.vaultBacked && (
            <Badge tone="positive" data-testid="vault-badge">
              {tt.vaultBadge}
            </Badge>
          )}
        </div>
        <div
          className="flex flex-1 flex-wrap items-center gap-x-6 gap-y-1 [&_dd]:text-[13px] [&_dt]:text-[11px]"
          data-testid="ticker"
        >
          <Stat label={tt.last} value={ticker?.last ?? null} />
          {isPerp && <PerpStatsStrip stats={perpStats} tp={tt.perp} inline />}
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
        </div>
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

      {/*
        Desktop: chart | book/trades | order form on top, account tabs under the
        chart and book, the order form running the full height on the right.
      */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 lg:grid-cols-[minmax(0,1fr)_300px_300px] lg:grid-rows-[600px_auto]">
        <section className="flex min-h-[420px] min-w-0 flex-col rounded-md border border-border bg-surface">
          <div className="flex gap-1 border-b border-border px-2 py-1.5">
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
          <div className="min-h-0 flex-1">
            <PriceChart candles={candles} emptyLabel={tt.noTradesYet} />
          </div>
        </section>

        <section className="flex min-h-[420px] flex-col overflow-hidden rounded-md border border-border bg-surface">
          <div role="tablist" className="flex border-b border-border text-xs">
            {(
              [
                ['book', tt.orderBook],
                ['trades', tt.recentTrades],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={bookTab === key}
                onClick={() => setBookTab(key)}
                className={cn(
                  '-mb-px flex-1 border-b-2 py-2 font-medium',
                  bookTab === key
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {bookTab === 'book' ? (
              <OrderBook book={book} t={tt} scales={scales} onPick={setPrice} depth={11} />
            ) : (
              <RecentTrades trades={trades} t={tt} />
            )}
          </div>
        </section>

        <aside className="rounded-md border border-border bg-surface lg:row-span-2 lg:overflow-y-auto">
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
              leverage={positions.find((p) => p.market === symbol)?.leverage ?? null}
              bbo={{ bid: book?.bids[0]?.[0] ?? null, ask: book?.asks[0]?.[0] ?? null }}
            />
          )}
          {market && signedIn && <AlgoPanel market={market} t={t} />}
        </aside>

        <section
          className="min-h-[220px] rounded-md border border-border bg-surface lg:col-span-2"
          data-testid="account-panel"
        >
          {signedIn ? (
            <>
              {isPerp && market && (
                <div role="tablist" className="flex gap-1 border-b border-border px-2 text-xs">
                  {(
                    [
                      ['positions', `${tt.perp.positions} (${openPositions})`],
                      ['orders', `${tt.openOrders} (${openOrders})`],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={accountTab === key}
                      onClick={() => setAccountTab(key)}
                      className={cn(
                        '-mb-px border-b-2 px-3 py-2 font-medium',
                        accountTab === key
                          ? 'border-primary text-foreground'
                          : 'border-transparent text-muted hover:text-foreground',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {isPerp && market && accountTab === 'positions' ? (
                <PositionsPanel
                  positions={positions}
                  market={market}
                  tp={tt.perp}
                  onChanged={refreshPrivate}
                />
              ) : (
                <MyOrders orders={orders} trades={myTrades} t={tt} onChanged={refreshPrivate} />
              )}
            </>
          ) : (
            <p className="p-4 text-sm text-muted">
              <Link href="/connect" className="text-primary underline">
                {tt.signInToTrade}
              </Link>
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
