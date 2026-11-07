'use client';

import type { VaultConfigDto, VaultProofDto, WithdrawalDto } from '@platform/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { encodeFunctionData, parseAbi, parseUnits, type Hex } from 'viem';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';

const VAULT_ABI = parseAbi([
  'function deposit(address token, uint256 amount) returns (uint64)',
  'function withdraw((bytes32 id, address user, address token, uint256 amount, uint64 afterState, uint64 expiry) w, bytes signature)',
]);
const ERC20_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function eth(): Eip1193 | null {
  return (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;
}

type Msg = { tone: 'error' | 'success' | 'info'; text: string } | null;

function message(err: unknown): string {
  if (err instanceof ApiError) return err.details?.[0]?.message ?? err.message;
  const e = err as { code?: number; message?: string };
  if (e.code === 4001) return 'Declined in your wallet.';
  return e.message ?? 'Something went wrong.';
}

/**
 * Non-custodial vault (ADR-0014), TESTNET / LOCAL CHAIN ONLY. Funds sit in the
 * vault contract; withdrawals are operator-signed and submitted by the user's
 * own wallet; the latest balance proof lets the user exit without us.
 */
export function VaultPanel({ t, walletAddress }: { t: Dictionary; walletAddress: string | null }) {
  const v = t.vault;
  const [config, setConfig] = useState<VaultConfigDto | null>(null);
  const [withdrawals, setWithdrawals] = useState<WithdrawalDto[]>([]);
  const [asset, setAsset] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [now, setNow] = useState(0);

  const load = useCallback(() => {
    api<VaultConfigDto>('/v1/vault/config')
      .then((c) => {
        setConfig(c);
        setAsset((a) => a || c.tokens[0]?.asset || '');
      })
      .catch(() => setConfig(null));
    api<{ withdrawals: WithdrawalDto[] }>('/v1/vault/withdrawals')
      .then((r) => {
        setWithdrawals(r.withdrawals);
        setNow(Date.now());
      })
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  if (!config) return null;
  if (!config.enabled)
    return (
      <Card className="p-5">
        <CardTitle>{v.title}</CardTitle>
        <CardDescription>{v.notConfigured}</CardDescription>
      </Card>
    );

  const token = config.tokens.find((x) => x.asset === asset);

  async function ensureChain(provider: Eip1193): Promise<string> {
    const [from] = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
    if (!from) throw new Error(v.noAccount);
    if (walletAddress && from.toLowerCase() !== walletAddress.toLowerCase())
      throw new Error(v.wrongAccount);
    const hexId = `0x${config!.chainId!.toString(16)}`;
    const current = (await provider.request({ method: 'eth_chainId' })) as string;
    if (current.toLowerCase() !== hexId) {
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: hexId }],
        });
      } catch (err) {
        if ((err as { code?: number }).code !== 4902 || config!.chainId !== 31337) throw err;
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: hexId,
              chainName: 'Local test chain (no value)',
              rpcUrls: ['http://localhost:8545'],
              nativeCurrency: { name: 'Test ETH', symbol: 'ETH', decimals: 18 },
            },
          ],
        });
      }
    }
    return from;
  }

  /** Sends a transaction and waits until it is mined (the next call may depend on it). */
  async function send(provider: Eip1193, from: string, to: string, data: Hex): Promise<string> {
    const hash = (await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to, data }],
    })) as string;
    for (let i = 0; i < 120; i++) {
      const receipt = (await provider.request({
        method: 'eth_getTransactionReceipt',
        params: [hash],
      })) as { status: string } | null;
      if (receipt) {
        if (receipt.status !== '0x1') throw new Error(v.reverted);
        return hash;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(v.pending);
  }

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ tone: 'success', text: await action() });
      load();
    } catch (err) {
      setMsg({ tone: 'error', text: message(err) });
    } finally {
      setBusy(false);
    }
  }

  const deposit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const provider = eth();
      if (!provider || !token) throw new Error(v.noWallet);
      const from = await ensureChain(provider);
      const units = parseUnits(amount, token.decimals);
      await send(
        provider,
        from,
        token.address,
        encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [config.vault as Hex, units],
        }),
      );
      await send(
        provider,
        from,
        config.vault!,
        encodeFunctionData({
          abi: VAULT_ABI,
          functionName: 'deposit',
          args: [token.address as Hex, units],
        }),
      );
      setAmount('');
      return v.depositSent;
    });
  };

  const submitWithdrawal = (w: WithdrawalDto) =>
    run(async () => {
      const provider = eth();
      if (!provider) throw new Error(v.noWallet);
      const from = await ensureChain(provider);
      const c = w.call.withdrawal;
      const data = encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'withdraw',
        args: [
          {
            id: c.id as Hex,
            user: c.user as Hex,
            token: c.token as Hex,
            amount: BigInt(c.amount),
            afterState: BigInt(c.afterState),
            expiry: BigInt(c.expiry),
          },
          w.call.signature as Hex,
        ],
      });
      await send(provider, from, w.call.vault, data);
      return v.withdrawalSent;
    });

  const withdraw = () => {
    void run(async () => {
      const w = await api<WithdrawalDto>('/v1/vault/withdrawals', {
        method: 'POST',
        body: { asset, amount },
      });
      setAmount('');
      await submitWithdrawal(w);
      return v.withdrawalSent;
    });
  };

  async function downloadProof() {
    const proof = await api<VaultProofDto>('/v1/vault/proof');
    const blob = new Blob(
      [JSON.stringify({ vault: config!.vault, chainId: config!.chainId, ...proof }, null, 2)],
      {
        type: 'application/json',
      },
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vault-proof-state-${proof.stateIndex ?? 'none'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (!walletAddress)
    return (
      <Card className="p-5">
        <CardTitle>{v.title}</CardTitle>
        <CardDescription>{v.walletOnly}</CardDescription>
      </Card>
    );

  return (
    <Card className="space-y-5 p-5" data-testid="vault-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle>
            {v.title} <Badge tone="warning">{v.testnet}</Badge>
          </CardTitle>
          <CardDescription>{v.intro}</CardDescription>
        </div>
        <div className="flex gap-2">
          {config.faucet && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api('/v1/vault/faucet', { method: 'POST', body: {} });
                  return v.faucetDone;
                })
              }
            >
              {v.faucet}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void downloadProof().catch((err: unknown) =>
                setMsg({ tone: 'error', text: message(err) }),
              )
            }
          >
            {v.downloadProof}
          </Button>
        </div>
      </div>
      <p className="font-mono text-xs text-muted">
        {v.vault}: {config.vault} · chain {config.chainId}
      </p>
      <form
        className="grid gap-3 sm:grid-cols-[160px_1fr_auto_auto] sm:items-end"
        onSubmit={deposit}
      >
        <div>
          <Label htmlFor="vault-asset">{v.asset}</Label>
          <select
            id="vault-asset"
            value={asset}
            onChange={(e) => setAsset(e.target.value)}
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
          >
            {config.tokens.map((x) => (
              <option key={x.asset} value={x.asset}>
                {x.asset}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="vault-amount">{v.amount}</Label>
          <Input
            id="vault-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.trim())}
            dir="ltr"
          />
        </div>
        <Button type="submit" disabled={busy || !amount}>
          {v.deposit}
        </Button>
        <Button type="button" variant="outline" disabled={busy || !amount} onClick={withdraw}>
          {v.withdraw}
        </Button>
      </form>
      {msg && <Alert tone={msg.tone === 'info' ? 'warning' : msg.tone}>{msg.text}</Alert>}
      <ul className="list-disc space-y-1 ps-5 text-xs text-muted">
        {v.notes.map((n) => (
          <li key={n}>
            {n.replace('{days}', String(Math.round((config.freezeDelaySeconds ?? 0) / 86400)))}
          </li>
        ))}
      </ul>
      {withdrawals.length > 0 && (
        <ul className="space-y-3" data-testid="withdrawals">
          {withdrawals.map((w) => {
            const expired = w.status === 'expired';
            const executed = w.status === 'executed';
            const open = w.status === 'signed' && Date.parse(w.expiresAt) > now;
            const time = (iso: string) => new Date(iso).toLocaleString('en');
            // The steps a withdrawal goes through; the current one is highlighted.
            const steps: {
              label: string;
              detail: string;
              state: 'done' | 'current' | 'todo' | 'stopped';
            }[] = [
              { label: v.timeline.requested, detail: time(w.createdAt), state: 'done' },
              { label: v.timeline.signed, detail: v.timeline.signedDetail, state: 'done' },
              executed
                ? {
                    label: v.timeline.confirmed,
                    detail: w.txHash ? `${w.txHash.slice(0, 10)}…${w.txHash.slice(-6)}` : '',
                    state: 'done',
                  }
                : expired
                  ? {
                      label: v.timeline.expired,
                      detail: v.timeline.expiredDetail,
                      state: 'stopped',
                    }
                  : {
                      label: v.timeline.waiting,
                      detail: v.timeline.waitingDetail.replace('{time}', time(w.expiresAt)),
                      state: 'current',
                    },
            ];
            return (
              <li
                key={w.id}
                className="rounded-md border border-border p-3"
                data-testid="withdrawal"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-sm">
                    {w.amount} {w.asset}
                  </span>
                  <Badge tone={executed ? 'positive' : expired ? 'neutral' : 'info'}>
                    {v.statuses[w.status]}
                  </Badge>
                </div>
                <ol className="mt-3 grid gap-2 sm:grid-cols-3">
                  {steps.map((st) => (
                    <li key={st.label} className="flex gap-2 text-xs">
                      <span
                        aria-hidden
                        className={
                          st.state === 'done'
                            ? 'mt-1 size-2 shrink-0 rounded-full bg-positive'
                            : st.state === 'current'
                              ? 'mt-1 size-2 shrink-0 rounded-full bg-primary'
                              : st.state === 'stopped'
                                ? 'mt-1 size-2 shrink-0 rounded-full bg-muted'
                                : 'mt-1 size-2 shrink-0 rounded-full border border-border'
                        }
                      />
                      <span>
                        <span className="block font-medium">{st.label}</span>
                        <span className="block text-muted">{st.detail}</span>
                      </span>
                    </li>
                  ))}
                </ol>
                {open && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    disabled={busy}
                    onClick={() => void submitWithdrawal(w)}
                  >
                    {v.submit}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
