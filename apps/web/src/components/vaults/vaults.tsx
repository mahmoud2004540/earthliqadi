'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';

interface VaultSummary {
  id: string;
  name: string;
  description: string;
  leader: string;
  asset: string;
  status: string;
  profitShareBps: number;
  minLeaderShareBps: number;
  maxLeverage: number;
  maxDrawdownBps: number;
  equity: string;
  sharePrice: string;
  holders: number;
  returnSinceInceptionBps: number;
  return30dBps: number | null;
  maxDrawdownSeenBps: number;
  createdAt: string;
  score?: number;
  curve?: { at: string; sharePrice: string }[];
}

const pct = (bps: number | null) => (bps === null ? '—' : `${(bps / 100).toFixed(2)}%`);
const tone = (bps: number | null) =>
  bps === null ? '' : bps >= 0 ? 'text-positive' : 'text-negative';

function randomKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** Public list of leader vaults, ranked by return over drawdown (ADR-0019). */
export function VaultList({ t }: { t: Dictionary }) {
  const v = t.vaults;
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  useEffect(() => {
    api<{ vaults: VaultSummary[] }>('/v1/leader-vaults')
      .then((r) => setVaults(r.vaults))
      .catch(() => setVaults([]));
  }, []);
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-12 sm:px-6" data-testid="vault-list">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{v.title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted">{v.intro}</p>
      </div>
      <ul className="grid gap-2 text-xs text-muted sm:grid-cols-2">
        {v.rules.map((r) => (
          <li key={r} className="rounded-md border border-border p-3">
            {r}
          </li>
        ))}
      </ul>
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[800px] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              {[
                v.name,
                v.leader,
                v.equity,
                v.sinceInception,
                v.days30,
                v.maxDd,
                v.profitShare,
                v.holders,
              ].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {vaults?.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-muted">
                  {v.none}
                </td>
              </tr>
            )}
            {vaults?.map((x) => (
              <tr key={x.id} className="border-t border-border" data-testid="vault-row">
                <td className="px-4 py-3">
                  <Link href={`/vaults/${x.id}`} className="font-medium hover:underline">
                    {x.name}
                  </Link>
                  {x.status !== 'open' && (
                    <Badge tone="warning" className="ms-2">
                      {x.status}
                    </Badge>
                  )}
                </td>
                <td className="font-mono text-xs">{x.leader}</td>
                <td className="font-mono">
                  {x.equity} {x.asset}
                </td>
                <td className={`font-mono ${tone(x.returnSinceInceptionBps)}`}>
                  {pct(x.returnSinceInceptionBps)}
                </td>
                <td className={`font-mono ${tone(x.return30dBps)}`}>{pct(x.return30dBps)}</td>
                <td className="font-mono">{pct(-x.maxDrawdownSeenBps)}</td>
                <td className="font-mono">{pct(x.profitShareBps)}</td>
                <td>{x.holders}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <CreateVault t={t} />
      <p className="text-xs text-muted">{v.disclaimer}</p>
    </div>
  );
}

function CreateVault({ t }: { t: Dictionary }) {
  const v = t.vaults;
  const [form, setForm] = useState({
    name: '',
    description: '',
    asset: '',
    profitShare: '10',
    maxLeverage: '5',
    maxDrawdown: '30',
    initialDeposit: '',
  });
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const r = await api<{ id: string; accountId: string }>('/v1/leader-vaults', {
        method: 'POST',
        body: {
          name: form.name,
          description: form.description,
          asset: form.asset.trim().toUpperCase(),
          profitShareBps: Math.round(Number(form.profitShare) * 100),
          maxLeverage: Number(form.maxLeverage),
          maxDrawdownBps: Math.round(Number(form.maxDrawdown) * 100),
          initialDeposit: form.initialDeposit,
        },
      });
      setMsg({ tone: 'success', text: `${v.created} ${r.accountId}` });
    } catch (err) {
      setMsg({
        tone: 'error',
        text: err instanceof ApiError ? (err.details?.[0]?.message ?? err.message) : String(err),
      });
    }
  }
  const field = (k: keyof typeof form, label: string, extra: Record<string, unknown> = {}) => (
    <div>
      <Label htmlFor={`cv-${k}`}>{label}</Label>
      <Input id={`cv-${k}`} value={form[k]} onChange={set(k)} {...extra} />
    </div>
  );
  return (
    <Card className="p-6" data-testid="create-vault">
      <CardTitle>{v.createTitle}</CardTitle>
      <CardDescription>{v.createIntro}</CardDescription>
      <form onSubmit={(e) => void submit(e)} className="mt-4 grid gap-3 sm:grid-cols-3">
        {field('name', v.name, { required: true, minLength: 3, maxLength: 48 })}
        {field('asset', v.asset, { required: true })}
        {field('initialDeposit', v.initialDeposit, { required: true, inputMode: 'decimal' })}
        {field('profitShare', v.profitSharePct, { inputMode: 'decimal' })}
        {field('maxLeverage', v.maxLeverage, { inputMode: 'numeric' })}
        {field('maxDrawdown', v.ddLimitPct, { inputMode: 'decimal' })}
        <div className="sm:col-span-3">
          {field('description', v.description, { maxLength: 280 })}
        </div>
        <div className="sm:col-span-3">
          <Button type="submit">{v.create}</Button>
        </div>
      </form>
      {msg && (
        <Alert tone={msg.tone} className="mt-3">
          {msg.text}
        </Alert>
      )}
    </Card>
  );
}

/** One vault: track record, terms, and deposit / redeem for the signed-in wallet. */
export function VaultDetail({ t, id }: { t: Dictionary; id: string }) {
  const v = t.vaults;
  const [vault, setVault] = useState<VaultSummary | null>(null);
  const [mine, setMine] = useState<{ shares: string; value: string } | null>(null);
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(null);
  const load = useCallback(() => {
    api<VaultSummary>(`/v1/leader-vaults/${id}`)
      .then(setVault)
      .catch(() => setVault(null));
    api<{ shares: string; value: string }>(`/v1/leader-vaults/${id}/me`)
      .then(setMine)
      .catch(() => setMine(null));
  }, [id]);
  useEffect(load, [load]);

  const fail = (err: unknown) =>
    setMsg({
      tone: 'error',
      text: err instanceof ApiError ? (err.details?.[0]?.message ?? err.message) : String(err),
    });

  async function deposit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api(`/v1/leader-vaults/${id}/deposit`, {
        method: 'POST',
        body: { amount, idempotencyKey: randomKey() },
      });
      setAmount('');
      setMsg({ tone: 'success', text: v.deposited });
      load();
    } catch (err) {
      fail(err);
    }
  }

  async function redeemAll() {
    setMsg(null);
    try {
      const r = await api<{ status: string }>(`/v1/leader-vaults/${id}/redeem`, {
        method: 'POST',
        body: { shares: 'all' },
      });
      setMsg({
        tone: r.status === 'paid' ? 'success' : 'info',
        text: r.status === 'paid' ? v.paid : v.queued,
      });
      load();
    } catch (err) {
      fail(err);
    }
  }

  if (!vault) return <p className="mx-auto max-w-5xl px-4 py-16 text-muted">{v.loading}</p>;
  const points = vault.curve ?? [];
  const prices = points.map((p) => Number(p.sharePrice));
  const lo = Math.min(...prices, 1);
  const hi = Math.max(...prices, 1);
  const path = points
    .map((p, i) => {
      const x = points.length > 1 ? (i / (points.length - 1)) * 600 : 0;
      const y = 150 - ((Number(p.sharePrice) - lo) / (hi - lo || 1)) * 140 - 5;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-12 sm:px-6" data-testid="vault-detail">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{vault.name}</h1>
        <p className="mt-1 text-sm text-muted">
          {v.leader}: <span className="font-mono">{vault.leader}</span> · {vault.asset}
        </p>
        {vault.description && <p className="mt-3 text-sm">{vault.description}</p>}
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        {[
          [v.equity, `${vault.equity} ${vault.asset}`],
          [v.sharePriceLabel, vault.sharePrice],
          [v.sinceInception, pct(vault.returnSinceInceptionBps)],
          [v.maxDd, pct(-vault.maxDrawdownSeenBps)],
        ].map(([k, val]) => (
          <Card key={k} className="p-4">
            <CardDescription className="mt-0">{k}</CardDescription>
            <p className="mt-1 font-mono text-lg">{val}</p>
          </Card>
        ))}
      </div>
      <Card className="p-6">
        <CardTitle>{v.curve}</CardTitle>
        {points.length > 1 ? (
          <svg viewBox="0 0 600 150" className="mt-4 h-40 w-full" role="img" aria-label={v.curve}>
            <path
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-primary"
            />
          </svg>
        ) : (
          <p className="mt-3 text-sm text-muted">{v.noHistory}</p>
        )}
      </Card>
      <Card className="p-6">
        <CardTitle>{v.terms}</CardTitle>
        <ul className="mt-3 space-y-1 text-sm">
          <li>
            {v.profitShare}: {pct(vault.profitShareBps)} ({v.aboveHwm})
          </li>
          <li>
            {v.leaderMin}: {pct(vault.minLeaderShareBps)}
          </li>
          <li>
            {v.maxLeverage}: {vault.maxLeverage}x · {v.ddLimit}: {pct(vault.maxDrawdownBps)}
          </li>
          <li>{v.exitRule}</li>
        </ul>
      </Card>
      <Card className="p-6">
        <CardTitle>{v.yourShare}</CardTitle>
        <p className="mt-2 font-mono text-sm">{mine ? `${mine.value} ${vault.asset}` : v.signIn}</p>
        {mine && (
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <form onSubmit={(e) => void deposit(e)} className="flex items-end gap-2">
              <div>
                <Label htmlFor="vault-amount">{v.amount}</Label>
                <Input
                  id="vault-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.trim())}
                  required
                />
              </div>
              <Button type="submit">{v.deposit}</Button>
            </form>
            {mine.shares !== '0' && (
              <Button variant="outline" onClick={() => void redeemAll()}>
                {v.redeemAll}
              </Button>
            )}
          </div>
        )}
        {msg && (
          <Alert tone={msg.tone} className="mt-3">
            {msg.text}
          </Alert>
        )}
      </Card>
      <p className="text-xs text-muted">{v.disclaimer}</p>
    </div>
  );
}
