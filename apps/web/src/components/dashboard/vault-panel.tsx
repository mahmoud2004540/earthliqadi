'use client';

import type {
  VaultConfigDto,
  VaultProofDto,
  WalletBalancesDto,
  WithdrawalDto,
} from '@platform/shared';
import Link from 'next/link';
import QRCode from 'qrcode';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { encodeFunctionData, parseAbi, formatUnits, parseUnits, type Hex } from 'viem';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { useEmailWallet } from '@/components/wallet/email-wallet';
import { ApiError, api } from '@/lib/api';
import { walletProvider, type Eip1193 } from '@/lib/wallet';

const VAULT_ABI = parseAbi([
  'function deposit(address token, uint256 amount) returns (uint64)',
  'function withdraw((bytes32 id, address user, address token, uint256 amount, uint64 afterState, uint64 expiry) w, bytes signature)',
]);
const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  // Test tokens only (no value): anyone can mint up to a per-call limit.
  'function mint(address to, uint256 amount)',
]);

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
  const email = useEmailWallet();
  const [copied, setCopied] = useState(false);
  // Deposit / withdraw sheet, modelled on the usual exchange flow (ADR-0036).
  const [sheet, setSheet] = useState<null | 'menu' | 'transfer' | 'fiat' | 'withdraw'>(null);
  const [walletTokens, setWalletTokens] = useState<WalletBalancesDto | null>(null);
  const [arrived, setArrived] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const lastSeen = useRef<Map<string, string>>(new Map());
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

  // While the transfer view is open, watch the wallet so arrivals show up.
  useEffect(() => {
    if (sheet !== 'transfer' || !walletAddress) return;
    let active = true;
    const poll = () =>
      api<WalletBalancesDto>('/v1/vault/wallet')
        .then((w) => {
          if (!active) return;
          for (const x of w.tokens) {
            const before = lastSeen.current.get(x.asset);
            if (before !== undefined && Number(x.balance) > Number(before))
              setArrived(
                t.vault.arrived.replaceAll('{asset}', x.asset).replace('{balance}', x.balance),
              );
            lastSeen.current.set(x.asset, x.balance);
          }
          setWalletTokens(w);
        })
        .catch(() => undefined);
    void poll();
    const id = setInterval(() => void poll(), 8000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [sheet, walletAddress, t.vault.arrived]);

  // Escape closes the sheet, unless a wallet request is in progress.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) setSheet(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet, busy]);

  // QR code of the wallet address, drawn locally (no third-party image service).
  useEffect(() => {
    if (!walletAddress) return;
    void QRCode.toDataURL(walletAddress, { margin: 1, width: 400 }).then(setQr, () => setQr(null));
  }, [walletAddress]);

  if (!config) return null;
  if (!config.enabled)
    return (
      <Card className="p-5">
        <CardTitle>{v.title}</CardTitle>
        <CardDescription>{v.notConfigured}</CardDescription>
      </Card>
    );

  const token = config.tokens.find((x) => x.asset === asset);
  const networkName = config.network?.name ?? `chain ${config.chainId}`;
  const walletBalance = walletTokens?.tokens.find((x) => x.asset === asset)?.balance;

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
        // 4902: the wallet does not know the network yet; offer to add it (test networks only).
        const net = config!.network;
        if ((err as { code?: number }).code !== 4902 || !net) throw err;
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: hexId,
              chainName: net.name,
              rpcUrls: [net.rpcUrl],
              nativeCurrency: { name: 'Test ETH', symbol: 'ETH', decimals: 18 },
              ...(net.explorerUrl ? { blockExplorerUrls: [net.explorerUrl] } : {}),
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
      const provider = await walletProvider(walletAddress, config.chainId ?? undefined);
      if (!provider || !token) throw new Error(v.noWallet);
      const units = parseUnits(amount, token.decimals);
      if (token.depositCap) {
        // The contract would refuse it; say why before the wallet asks to sign.
        const room =
          parseUnits(token.depositCap, token.decimals) -
          parseUnits(token.held ?? '0', token.decimals);
        if (units > room)
          throw new Error(
            v.depositCapFull
              .replace('{room}', formatUnits(room > 0n ? room : 0n, token.decimals))
              .replace('{asset}', token.asset),
          );
      }
      const from = await ensureChain(provider);
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

  const faucet = () =>
    void run(async () => {
      await api('/v1/vault/faucet', { method: 'POST', body: {} });
      return v.faucetDone;
    });

  const mint = () =>
    void run(async () => {
      const provider = await walletProvider(walletAddress, config.chainId ?? undefined);
      if (!provider) throw new Error(v.noWallet);
      const from = await ensureChain(provider);
      for (const x of config.tokens) {
        await send(
          provider,
          from,
          x.address,
          encodeFunctionData({
            abi: ERC20_ABI,
            functionName: 'mint',
            args: [from as Hex, 1000n * 10n ** BigInt(x.decimals)],
          }),
        );
      }
      return v.mintDone;
    });

  const submitWithdrawal = (w: WithdrawalDto) =>
    run(async () => {
      const provider = await walletProvider(walletAddress, config.chainId ?? undefined);
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
            <Button size="sm" variant="outline" disabled={busy} onClick={faucet}>
              {v.faucet}
            </Button>
          )}
          {config.selfMint && (
            <Button size="sm" variant="outline" disabled={busy} onClick={mint}>
              {v.mint}
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
        {v.vault}:{' '}
        {config.network?.explorerUrl ? (
          <a
            className="underline"
            href={`${config.network.explorerUrl}/address/${config.vault}`}
            target="_blank"
            rel="noreferrer"
          >
            {config.vault}
          </a>
        ) : (
          config.vault
        )}{' '}
        · {config.network?.name ?? `chain ${config.chainId}`}
      </p>
      {email.address && email.address.toLowerCase() === walletAddress.toLowerCase() && (
        <div
          className="space-y-2 rounded-md border border-border p-3"
          data-testid="email-wallet-card"
        >
          <p className="text-sm font-medium">{v.emailWalletTitle}</p>
          <p className="break-all font-mono text-xs">{email.address}</p>
          <p className="text-xs text-muted">
            {v.emailWalletHelp.replace(
              '{network}',
              config.network?.name ?? `chain ${config.chainId}`,
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(email.address ?? '').then(() => setCopied(true))
              }
            >
              {copied ? v.copied : v.copy}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void email
                  .exportKey()
                  .catch((err: unknown) => setMsg({ tone: 'error', text: message(err) }))
              }
            >
              {v.exportKey}
            </Button>
          </div>
          <p className="text-xs text-muted">{v.exportHelp}</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Button onClick={() => setSheet('menu')} data-testid="open-deposit">
          {v.deposit}
        </Button>
        <Button variant="outline" onClick={() => setSheet('withdraw')} data-testid="open-withdraw">
          {v.withdraw}
        </Button>
      </div>
      {sheet &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
            role="dialog"
            aria-modal="true"
            aria-labelledby="vault-sheet-title"
            onClick={(e) => {
              if (e.target === e.currentTarget && !busy) setSheet(null);
            }}
          >
            <div
              className="max-h-[92dvh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-2xl border border-border bg-surface p-5 sm:rounded-2xl"
              data-testid={`sheet-${sheet}`}
            >
              <div className="flex items-center justify-between gap-2">
                {sheet !== 'menu' && sheet !== 'withdraw' ? (
                  <button
                    type="button"
                    className="text-sm text-muted hover:text-foreground"
                    onClick={() => setSheet('menu')}
                    aria-label={v.back}
                  >
                    ‹ {v.back}
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  className="text-xl leading-none text-muted hover:text-foreground"
                  onClick={() => setSheet(null)}
                  disabled={busy}
                  aria-label={v.close}
                >
                  ×
                </button>
              </div>
              <h2 id="vault-sheet-title" className="text-2xl font-semibold tracking-tight">
                {sheet === 'menu'
                  ? v.deposit
                  : sheet === 'transfer'
                    ? v.transferTitle.replace('{asset}', asset).replace('{network}', networkName)
                    : sheet === 'fiat'
                      ? v.fiatTitle
                      : v.withdraw}
              </h2>

              {sheet === 'menu' && (
                <div className="space-y-3">
                  <button
                    type="button"
                    className="w-full rounded-xl border border-border p-4 text-start hover:border-primary"
                    onClick={() => setSheet('transfer')}
                    data-testid="choose-transfer"
                  >
                    <span className="block text-lg font-medium">{v.transferOption}</span>
                    <span className="block text-sm text-muted">{v.transferOptionHelp}</span>
                  </button>
                  <button
                    type="button"
                    className="w-full rounded-xl border border-border p-4 text-start hover:border-primary"
                    onClick={() => setSheet('fiat')}
                    data-testid="choose-fiat"
                  >
                    <span className="flex items-center gap-2 text-lg font-medium">
                      {v.fiatOption} <Badge tone="neutral">{v.atLaunch}</Badge>
                    </span>
                    <span className="block text-sm text-muted">{v.fiatOptionHelp}</span>
                  </button>
                </div>
              )}

              {sheet === 'fiat' && (
                <div className="space-y-3 text-sm text-muted">
                  {v.fiatNotYet.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              )}

              {sheet === 'transfer' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                    <div>
                      <Label htmlFor="vault-asset">{v.youSend}</Label>
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
                    <span className="pb-2 text-sm text-muted">{v.on}</span>
                    <div>
                      <Label htmlFor="vault-network">{v.network}</Label>
                      <select
                        id="vault-network"
                        disabled
                        className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
                      >
                        <option>{networkName}</option>
                      </select>
                    </div>
                  </div>
                  {qr && (
                    // A local data: URL; next/image would add nothing here.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={qr}
                      alt={v.qrAlt}
                      width={200}
                      height={200}
                      className="mx-auto rounded-md bg-white p-2"
                      data-testid="deposit-qr"
                    />
                  )}
                  <div>
                    <p className="text-sm text-muted">{v.yourAddress}</p>
                    <button
                      type="button"
                      className="mt-1 w-full break-all rounded-md bg-background px-3 py-3 text-start font-mono text-sm"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(walletAddress)
                          .then(() => setCopied(true))
                      }
                      data-testid="deposit-address"
                    >
                      {walletAddress}{' '}
                      <span className="text-muted">· {copied ? v.copied : v.copy}</span>
                    </button>
                    <p className="mt-1 text-xs text-muted">{v.yourAddressHelp}</p>
                  </div>
                  <dl className="space-y-2 rounded-md border border-border p-3 text-sm">
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted">{v.inWallet}</dt>
                      <dd className="font-mono" data-testid="wallet-balance">
                        {walletTokens?.tokens.find((x) => x.asset === asset)?.balance ?? '…'}{' '}
                        {asset}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted">{v.gasInWallet}</dt>
                      <dd className="font-mono">{walletTokens?.gas ?? '…'} ETH</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted">{v.youReceive}</dt>
                      <dd>{v.youReceiveValue.replace('{asset}', asset)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted">{v.processing}</dt>
                      <dd>{v.processingValue.replace('{n}', String(config.confirmations ?? 0))}</dd>
                    </div>
                  </dl>
                  {arrived && (
                    <Alert tone="success" data-testid="arrived">
                      {arrived}
                    </Alert>
                  )}
                  <form
                    className="grid grid-cols-[1fr_auto_auto] items-end gap-2"
                    onSubmit={deposit}
                  >
                    <div>
                      <Label htmlFor="vault-amount">{v.amount}</Label>
                      <Input
                        id="vault-amount"
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value.trim())}
                        placeholder={walletTokens?.tokens.find((x) => x.asset === asset)?.balance}
                        dir="ltr"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || !walletBalance || walletBalance === '0'}
                      onClick={() => setAmount(walletBalance ?? '')}
                    >
                      {v.max}
                    </Button>
                    <Button type="submit" disabled={busy || !amount} data-testid="move-to-exchange">
                      {v.moveToExchange}
                    </Button>
                  </form>
                  {token?.depositCap && (
                    <p className="text-xs text-muted" data-testid="deposit-cap">
                      {v.depositCap
                        .replace('{cap}', token.depositCap)
                        .replace('{held}', token.held ?? '0')
                        .replaceAll('{asset}', token.asset)}
                    </p>
                  )}
                  {(config.selfMint || config.faucet) && (
                    <p className="text-xs text-muted">
                      {v.needTestTokens}{' '}
                      <button
                        type="button"
                        className="underline"
                        disabled={busy}
                        onClick={() => void (config.faucet ? faucet() : mint())}
                      >
                        {config.faucet ? v.faucet : v.mint}
                      </button>
                      {config.selfMint &&
                        config.network?.gasFaucetInfo &&
                        ` ${v.gasHelp.replace('{gas}', config.network.gasFaucetInfo)}`}
                    </p>
                  )}
                  <div
                    className="rounded-md border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative"
                    data-testid="direct-transfer-warning"
                  >
                    {v.sendOnly.replace('{asset}', asset).replace('{network}', networkName)}{' '}
                    <Link className="underline" href="/deposit-guide">
                      {v.guideLink}
                    </Link>
                  </div>
                </div>
              )}

              {sheet === 'withdraw' && (
                <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), withdraw())}>
                  <div className="grid grid-cols-[120px_1fr] gap-2">
                    <div>
                      <Label htmlFor="withdraw-asset">{v.asset}</Label>
                      <select
                        id="withdraw-asset"
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
                      <Label htmlFor="withdraw-amount">{v.amount}</Label>
                      <Input
                        id="withdraw-amount"
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value.trim())}
                        dir="ltr"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted">
                    {v.withdrawTo
                      .replace('{address}', walletAddress)
                      .replace('{network}', networkName)}
                  </p>
                  <Button type="submit" className="w-full" disabled={busy || !amount}>
                    {v.withdraw}
                  </Button>
                </form>
              )}

              {msg && <Alert tone={msg.tone === 'info' ? 'warning' : msg.tone}>{msg.text}</Alert>}
            </div>
          </div>,
          // Portal: an ancestor card must not become the containing block of the overlay.
          document.body,
        )}
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
