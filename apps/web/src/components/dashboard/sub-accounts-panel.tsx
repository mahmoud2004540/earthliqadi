'use client';

import type { SubAccountDto } from '@platform/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';

function randomKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * Sub-accounts (ADR-0017): separate balances, orders and positions under the
 * same wallet. Bots act as one with the `X-Sub-Account` header.
 */
export function SubAccountsPanel({ t }: { t: Dictionary }) {
  const s = t.subAccounts;
  const [subs, setSubs] = useState<SubAccountDto[]>([]);
  const [label, setLabel] = useState('');
  const [to, setTo] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [asset, setAsset] = useState('');
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(() => {
    api<{ subAccounts: SubAccountDto[] }>('/v1/me/sub-accounts')
      .then((r) => {
        setSubs(r.subAccounts);
        setTo((v) => v || r.subAccounts[0]?.id || '');
      })
      .catch(() => setSubs([]));
  }, []);
  useEffect(load, [load]);

  const fail = (err: unknown) =>
    setMsg({
      tone: 'error',
      text: err instanceof ApiError ? (err.details?.[0]?.message ?? err.message) : String(err),
    });

  async function create(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/v1/me/sub-accounts', { method: 'POST', body: { label } });
      setLabel('');
      load();
    } catch (err) {
      fail(err);
    }
  }

  async function transfer(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/v1/me/sub-accounts/transfer', {
        method: 'POST',
        body: {
          from: direction === 'in' ? 'main' : to,
          to: direction === 'in' ? to : 'main',
          asset: asset.trim().toUpperCase(),
          amount,
          idempotencyKey: randomKey(),
        },
      });
      setAmount('');
      setMsg({ tone: 'success', text: s.transferred });
    } catch (err) {
      fail(err);
    }
  }

  return (
    <Card className="p-6" data-testid="sub-accounts">
      <CardTitle>{s.title}</CardTitle>
      <CardDescription>{s.intro}</CardDescription>
      <ul className="mt-4 space-y-1 text-sm">
        {subs.length === 0 && <li className="text-muted">{s.none}</li>}
        {subs.map((x) => (
          <li key={x.id} className="flex justify-between gap-4">
            <span>{x.label}</span>
            <span className="font-mono text-xs text-muted">{x.id}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => void create(e)} className="mt-4 flex gap-2">
        <Input
          aria-label={s.label}
          placeholder={s.label}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          minLength={2}
          maxLength={48}
          required
        />
        <Button type="submit" variant="outline">
          {s.create}
        </Button>
      </form>
      {subs.length > 0 && (
        <form onSubmit={(e) => void transfer(e)} className="mt-6 grid gap-3 sm:grid-cols-4">
          <div>
            <Label htmlFor="sub-dir">{s.direction}</Label>
            <select
              id="sub-dir"
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'in' | 'out')}
            >
              <option value="in">{s.toSub}</option>
              <option value="out">{s.toMain}</option>
            </select>
          </div>
          <div>
            <Label htmlFor="sub-target">{s.subAccount}</Label>
            <select
              id="sub-target"
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            >
              {subs.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="sub-asset">{s.asset}</Label>
            <Input
              id="sub-asset"
              value={asset}
              onChange={(e) => setAsset(e.target.value)}
              required
            />
          </div>
          <div>
            <Label htmlFor="sub-amount">{s.amount}</Label>
            <Input
              id="sub-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.trim())}
              required
            />
          </div>
          <div className="sm:col-span-4">
            <Button type="submit">{s.transfer}</Button>
          </div>
        </form>
      )}
      {msg && (
        <Alert tone={msg.tone} className="mt-3">
          {msg.text}
        </Alert>
      )}
    </Card>
  );
}
