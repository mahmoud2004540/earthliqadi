'use client';

import { notional, type BalanceDto, type MarketDto } from '@platform/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { errorMessage } from '@/components/auth/shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';
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
}: OrderFormProps) {
  const tt = t.terminal;
  const [side, setSide] = useState<Side>('buy');
  const [type, setType] = useState<OrderType>('limit');
  const [tif, setTif] = useState<Tif>('gtc');
  const [stopPrice, setStopPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  async function faucet(asset: string) {
    setMessage(null);
    try {
      await api('/v1/paper/faucet', { method: 'POST', body: { asset } });
      setMessage({ tone: 'success', text: tt.paperFundsGranted });
      onPlaced();
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiError ? err.message : errorMessage(t.auth, err),
      });
    }
  }

  const isMarketLike = type === 'market' || type === 'stop_market';
  const isStop = type === 'stop_limit' || type === 'stop_market';
  const holdAsset = side === 'buy' ? market.quote : market.base;
  const available = balances.find((b) => b.asset === holdAsset)?.available ?? '0';
  // Exact maximum hold: buys hold price × quantity in quote; sells hold the quantity in base.
  const total = price && quantity ? notional(price, quantity, scales.base, scales.quote) : null;
  const hold = side === 'buy' ? total : quantity || null;
  const priceLabel = isMarketLike
    ? side === 'buy'
      ? tt.protectionPrice
      : tt.protectionPriceSell
    : tt.price;

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
    <form onSubmit={submit} className="space-y-3 p-4" noValidate data-testid="order-form">
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
            {s === 'buy' ? tt.buy : tt.sell}
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
          <Label htmlFor="stopPrice">
            {tt.stopPrice} ({market.quote})
          </Label>
          <Input
            id="stopPrice"
            inputMode="decimal"
            value={stopPrice}
            onChange={(e) => setStopPrice(e.target.value.trim())}
            dir="ltr"
          />
        </div>
      )}
      <div>
        <Label htmlFor="price">
          {priceLabel} ({market.quote})
        </Label>
        <Input
          id="price"
          inputMode="decimal"
          value={price}
          onChange={(e) => onPriceChange(e.target.value.trim())}
          dir="ltr"
        />
        {isMarketLike && <p className="mt-1 text-xs text-muted">{tt.protectionHint}</p>}
      </div>
      <div>
        <Label htmlFor="quantity">
          {tt.quantity} ({market.base})
        </Label>
        <Input
          id="quantity"
          inputMode="decimal"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value.trim())}
          placeholder={`${market.lotSize}`}
          dir="ltr"
        />
      </div>
      {!isMarketLike && (
        <div>
          <Label htmlFor="tif">{tt.timeInForce}</Label>
          <select
            id="tif"
            value={tif}
            onChange={(e) => setTif(e.target.value as Tif)}
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
          >
            <option value="gtc">GTC</option>
            <option value="ioc">IOC</option>
            <option value="fok">FOK</option>
            {type === 'limit' && <option value="post_only">Post only</option>}
          </select>
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
            {side === 'buy'
              ? total
                ? `${total} ${market.quote}`
                : '—'
              : hold
                ? `${hold} ${market.base}`
                : '—'}
          </dd>
        </div>
      </dl>

      {market.paper && (
        <div className="grid gap-2" data-testid="paper-faucet">
          {[market.base, market.quote].map((asset) => (
            <Button
              key={asset}
              type="button"
              size="sm"
              variant="outline"
              className="w-full min-w-0"
              title={`${tt.getPaperFunds} ${asset}`}
              onClick={() => void faucet(asset)}
            >
              <span className="truncate">
                {tt.getPaperFunds} {asset}
              </span>
            </Button>
          ))}
        </div>
      )}
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
        {side === 'buy' ? tt.placeBuy : tt.placeSell} {market.base}
      </Button>
      <p className="text-center text-[11px] text-muted">
        {market.paper ? tt.paperNotice : tt.simulatedNotice}
      </p>
    </form>
  );
}
