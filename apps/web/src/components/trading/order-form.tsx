'use client';

import {
  formatAmountTrimmed,
  notional,
  parseAmount,
  type BalanceDto,
  type MarketDto,
} from '@platform/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { errorMessage } from '@/components/auth/shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { sizeForPercent } from '@/lib/order-size';
import { cn } from '@/lib/utils';

type Side = 'buy' | 'sell';
type OrderType = 'limit' | 'market' | 'stop_limit' | 'stop_market';
type Tif = 'gtc' | 'ioc' | 'fok' | 'post_only';

export interface OrderFormProps {
  market: MarketDto;
  scales: { base: number; quote: number };
  balances: BalanceDto[];
  signedIn: boolean;
  disabled: boolean;
  price: string;
  onPriceChange: (price: string) => void;
  onPlaced: () => void;
  t: Dictionary;
  /** Perpetuals: the user's leverage on this market (null until known). */
  leverage?: number | null;
  /** Best visible bid and ask, for the BBO button. */
  bbo?: { bid: string | null; ask: string | null };
}

export function OrderForm({
  market,
  scales,
  balances,
  signedIn,
  disabled,
  price,
  onPriceChange,
  onPlaced,
  t,
  leverage = null,
  bbo = { bid: null, ask: null },
}: OrderFormProps) {
  const tt = t.terminal;
  const tp = tt.perp;
  const perp = market.kind === 'perpetual';
  const [reduceOnly, setReduceOnly] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [leverageInput, setLeverageInput] = useState('');
  const [side, setSide] = useState<Side>('buy');
  const [type, setType] = useState<OrderType>('limit');
  const [tif, setTif] = useState<Tif>('gtc');
  const [stopPrice, setStopPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [pct, setPct] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const isMarketLike = type === 'market' || type === 'stop_market';
  const isStop = type === 'stop_limit' || type === 'stop_market';
  const hiddenAllowed = type === 'limit' && (tif === 'gtc' || tif === 'post_only');
  // BBO: rest at the best price on your own side (a maker at the top of the book).
  const bboPrice = side === 'buy' ? bbo.bid : bbo.ask;
  const holdAsset = perp || side === 'buy' ? market.quote : market.base;
  const available = balances.find((b) => b.asset === holdAsset)?.available ?? '0';
  // Exact maximum hold: buys hold price × quantity in quote; sells hold the quantity in base.
  const total = price && quantity ? notional(price, quantity, scales.base, scales.quote) : null;
  const hold = side === 'buy' ? total : quantity || null;
  const lev = leverage ?? market.perp?.defaultLeverage ?? 1;
  let marginRequired: string | null = null;
  if (perp && total && !reduceOnly) {
    try {
      const minor = parseAmount(total, scales.quote);
      marginRequired = formatAmountTrimmed((minor + BigInt(lev) - 1n) / BigInt(lev), scales.quote);
    } catch {
      marginRequired = null;
    }
  }
  const priceLabel = isMarketLike
    ? side === 'buy'
      ? tt.protectionPrice
      : perp
        ? tp.protectionSell
        : tt.protectionPriceSell
    : tt.price;

  /** Fills the quantity with a share of what the free balance can open (Max reserves the fee). */
  function applyPercent(percent: number) {
    setPct(percent);
    const refPrice = price || (side === 'buy' ? bbo.ask : bbo.bid) || '';
    const q = sizeForPercent(
      {
        side,
        perp,
        available,
        price: refPrice,
        leverage: lev,
        takerFeeBps: market.takerFeeBps,
        lotSize: market.lotSize,
        scales,
      },
      percent,
    );
    setQuantity(percent === 0 ? '' : (q ?? ''));
  }

  async function changeLeverage() {
    setMessage(null);
    try {
      await api('/v1/perp/leverage', {
        method: 'POST',
        body: { market: market.symbol, leverage: Number(leverageInput) },
      });
      setLeverageInput('');
      setMessage({ tone: 'success', text: tp.leverageSet });
      onPlaced();
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiError ? err.message : errorMessage(t.auth, err),
      });
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api('/v1/orders', {
        method: 'POST',
        body: {
          market: market.symbol,
          clientOrderId: crypto.randomUUID(),
          side,
          type,
          timeInForce: isMarketLike ? (tif === 'fok' ? 'fok' : 'ioc') : tif,
          ...(price ? { price } : {}),
          ...(isStop ? { stopPrice } : {}),
          quantity,
          ...(perp && reduceOnly ? { reduceOnly: true } : {}),
          ...(hiddenAllowed && hidden ? { hidden: true } : {}),
        },
      });
      setMessage({ tone: 'success', text: tt.submitted });
      setQuantity('');
      onPlaced();
    } catch (err) {
      const detail = err instanceof ApiError ? err.details?.[0]?.message : undefined;
      setMessage({ tone: 'error', text: detail ?? errorMessage(t.auth, err) });
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted">{tt.signInToTrade}</p>
        <Button asChild>
          <Link href="/login">{t.nav.login}</Link>
        </Button>
      </div>
    );
  }

  const types: [OrderType, string][] = [
    ['limit', tt.limit],
    ['market', tt.marketOrder],
    ['stop_limit', tt.stopLimit],
    ['stop_market', tt.stopMarket],
  ];

  return (
    <form onSubmit={submit} className="space-y-2.5 p-3" noValidate data-testid="order-form">
      <div className="grid grid-cols-2 gap-1 rounded-md bg-background p-1">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            aria-pressed={side === s}
            className={cn(
              'rounded py-1.5 text-sm font-medium',
              side === s
                ? s === 'buy'
                  ? 'bg-positive text-background'
                  : 'bg-negative text-white'
                : 'text-muted',
            )}
          >
            {perp ? (s === 'buy' ? tp.long : tp.short) : s === 'buy' ? tt.buy : tt.sell}
          </button>
        ))}
      </div>
      <div role="tablist" className="flex gap-3 text-xs">
        {types.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={type === value}
            onClick={() => {
              setType(value);
              if (value === 'market' || value === 'stop_market') setTif('ioc');
              else if (tif === 'ioc' || tif === 'fok') setTif('gtc');
            }}
            className={cn(
              'pb-1',
              type === value ? 'border-b-2 border-primary text-foreground' : 'text-muted',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {isStop && (
        <div>
          <Label htmlFor="stopPrice" className="mb-1 text-xs text-muted">
            {tt.stopPrice} ({market.quote})
          </Label>
          <Input
            id="stopPrice"
            inputMode="decimal"
            value={stopPrice}
            onChange={(e) => setStopPrice(e.target.value.trim())}
            className="h-9"
            dir="ltr"
          />
        </div>
      )}
      <div>
        <Label htmlFor="price" className="mb-1 text-xs text-muted">
          {priceLabel} ({market.quote})
        </Label>
        <div className="flex gap-2">
          <Input
            id="price"
            inputMode="decimal"
            value={price}
            onChange={(e) => onPriceChange(e.target.value.trim())}
            className="h-9"
            dir="ltr"
          />
          {!isMarketLike && (
            <Button
              type="button"
              variant="outline"
              className="h-9 shrink-0 px-3 text-xs"
              disabled={!bboPrice}
              title={tt.bboHint}
              onClick={() => bboPrice && onPriceChange(bboPrice)}
              data-testid="bbo"
            >
              BBO
            </Button>
          )}
        </div>
        {isMarketLike && <p className="mt-1 text-xs text-muted">{tt.protectionHint}</p>}
      </div>
      <div>
        <Label htmlFor="quantity" className="mb-1 text-xs text-muted">
          {tt.quantity} ({market.base})
        </Label>
        <Input
          id="quantity"
          inputMode="decimal"
          value={quantity}
          onChange={(e) => {
            setQuantity(e.target.value.trim());
            setPct(0);
          }}
          placeholder={`${market.lotSize}`}
          className="h-9"
          dir="ltr"
        />
        <div className="mt-2" data-testid="size-slider">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={pct}
            aria-label={tt.sizePercent}
            onChange={(e) => applyPercent(Number(e.target.value))}
            className="h-1 w-full accent-primary"
          />
          <div className="mt-1 flex justify-between">
            {[25, 50, 75, 100].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => applyPercent(p)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[11px]',
                  pct === p
                    ? 'bg-surface-raised text-foreground'
                    : 'text-muted hover:text-foreground',
                )}
              >
                {p === 100 ? 'Max' : `${p}%`}
              </button>
            ))}
          </div>
        </div>
      </div>
      {!isMarketLike && (
        <div>
          <Label htmlFor="tif" className="mb-1 text-xs text-muted">
            {tt.timeInForce}
          </Label>
          <select
            id="tif"
            value={tif}
            onChange={(e) => setTif(e.target.value as Tif)}
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          >
            <option value="gtc">GTC</option>
            <option value="ioc">IOC</option>
            <option value="fok">FOK</option>
            {type === 'limit' && <option value="post_only">Post only</option>}
          </select>
        </div>
      )}
      {hiddenAllowed && (
        <label className="flex items-center gap-2 text-xs" title={tt.hiddenHint}>
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
            data-testid="hidden-order"
          />
          {tt.hidden}
        </label>
      )}

      {perp && (
        <div className="space-y-2 rounded-md border border-border p-2" data-testid="perp-controls">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted">{tp.leverage}</span>
            <span className="font-mono" data-testid="leverage">
              {lev}x
            </span>
            <Input
              aria-label={tp.leverage}
              inputMode="numeric"
              value={leverageInput}
              onChange={(e) => setLeverageInput(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder={`1-${market.perp?.maxLeverage ?? 1}`}
              className="h-7 w-16 text-xs"
              dir="ltr"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!leverageInput}
              onClick={() => void changeLeverage()}
            >
              {tp.setLeverage}
            </Button>
          </div>
          <p className="text-[11px] text-muted">{tp.leverageHint}</p>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={reduceOnly}
              onChange={(e) => setReduceOnly(e.target.checked)}
              data-testid="reduce-only"
            />
            {tp.reduceOnly}
          </label>
        </div>
      )}

      <dl className="space-y-1 text-xs">
        <div className="flex justify-between">
          <dt className="text-muted">{tt.available}</dt>
          <dd className="font-mono" data-testid="available">
            {available} {holdAsset}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">{isMarketLike ? tt.maxHold : tt.estimatedTotal}</dt>
          <dd className="font-mono" data-testid="order-total">
            {perp && (total ? `${total} ${market.quote}` : '—')}
            {!perp && side === 'buy'
              ? total
                ? `${total} ${market.quote}`
                : '—'
              : !perp && hold
                ? `${hold} ${market.base}`
                : !perp
                  ? '—'
                  : null}
          </dd>
        </div>
        {perp && (
          <div className="flex justify-between">
            <dt className="text-muted">{tp.initialMargin}</dt>
            <dd className="font-mono" data-testid="margin-required">
              {marginRequired ? `${marginRequired} ${market.quote}` : '—'}
            </dd>
          </div>
        )}
      </dl>

      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      <Button
        type="submit"
        disabled={busy || disabled || !quantity}
        className={cn(
          'w-full',
          side === 'buy'
            ? 'bg-positive text-background hover:bg-positive/90'
            : 'bg-negative hover:bg-negative/90',
        )}
      >
        {perp
          ? reduceOnly
            ? `${side === 'buy' ? tt.buy : tt.sell} (${tp.reduceOnly})`
            : side === 'buy'
              ? tp.placeLong
              : tp.placeShort
          : `${side === 'buy' ? tt.placeBuy : tt.placeSell} ${market.base}`}
      </Button>
      <p className="text-center text-[11px] text-muted">
        {perp ? tp.riskNotice : market.vaultBacked ? tt.vaultNotice : tt.simulatedNotice}
      </p>
    </form>
  );
}
