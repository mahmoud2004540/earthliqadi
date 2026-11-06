'use client';

import type { ApiKeyChallengeDto, ApiKeyDto } from '@platform/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function toHex(text: string): string {
  return `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Agent API keys (ADR-0017). The bot generates an Ed25519 key pair and keeps
 * the private key; the user registers the PUBLIC key here and authorises it
 * with a wallet signature. Keys can read and trade, never withdraw.
 */
export function ApiKeysPanel({
  t,
  walletAddress,
}: {
  t: Dictionary;
  walletAddress: string | null;
}) {
  const k = t.apiKeys;
  const [keys, setKeys] = useState<ApiKeyDto[]>([]);
  const [label, setLabel] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [trade, setTrade] = useState(true);
  const [days, setDays] = useState('90');
  const [ips, setIps] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(() => {
    api<{ keys: ApiKeyDto[] }>('/v1/me/api-keys')
      .then((r) => setKeys(r.keys))
      .catch(() => setKeys([]));
  }, []);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
    if (!eth || !walletAddress) {
      setMsg({ tone: 'error', text: k.needWallet });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const ch = await api<ApiKeyChallengeDto>('/v1/me/api-keys/challenge', {
        method: 'POST',
        body: {
          label,
          publicKey: publicKey.trim(),
          scopes: trade ? ['read', 'trade'] : ['read'],
          allowedIps: ips
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          expiresInDays: Number(days),
        },
      });
      const signature = (await eth.request({
        method: 'personal_sign',
        params: [toHex(ch.message), walletAddress],
      })) as string;
      const created = await api<ApiKeyDto>('/v1/me/api-keys', {
        method: 'POST',
        body: { challengeId: ch.challengeId, signature },
      });
      setMsg({ tone: 'success', text: `${k.created} ${created.id}` });
      setLabel('');
      setPublicKey('');
      load();
    } catch (err) {
      const rejected = (err as { code?: number }).code === 4001;
      setMsg({
        tone: 'error',
        text: rejected
          ? k.declined
          : err instanceof ApiError
            ? (err.details?.[0]?.message ?? err.message)
            : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await api(`/v1/me/api-keys/${id}`, { method: 'DELETE' }).catch(() => undefined);
    load();
  }

  const dateFmt = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });
  return (
    <Card className="p-6" data-testid="api-keys">
      <CardTitle>{k.title}</CardTitle>
      <CardDescription>{k.intro}</CardDescription>
      <ul className="mt-3 list-disc space-y-1 ps-5 text-xs text-muted">
        {k.rules.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>

      {walletAddress ? (
        <form onSubmit={(e) => void create(e)} className="mt-6 grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="key-label">{k.label}</Label>
            <Input
              id="key-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              minLength={2}
              maxLength={48}
            />
          </div>
          <div>
            <Label htmlFor="key-days">{k.expires}</Label>
            <Input
              id="key-days"
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="key-public">{k.publicKey}</Label>
            <Input
              id="key-public"
              className="font-mono"
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              placeholder="64 hex characters"
              required
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="key-ips">{k.ips}</Label>
            <Input
              id="key-ips"
              value={ips}
              onChange={(e) => setIps(e.target.value)}
              placeholder="203.0.113.0/24, 198.51.100.7"
            />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={trade} onChange={(e) => setTrade(e.target.checked)} />
            {k.tradeScope}
          </label>
          {msg && (
            <div className="sm:col-span-2">
              <Alert tone={msg.tone}>{msg.text}</Alert>
            </div>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy ? k.signing : k.authorize}
            </Button>
          </div>
        </form>
      ) : (
        <Alert tone="info">{k.needWallet}</Alert>
      )}

      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-2">{k.label}</th>
              <th>{k.scopes}</th>
              <th>{k.expires}</th>
              <th>{k.lastUsed}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr>
                <td colSpan={5} className="py-3 text-muted">
                  {k.none}
                </td>
              </tr>
            )}
            {keys.map((key) => (
              <tr key={key.id} className="border-t border-border" data-testid="api-key-row">
                <td className="py-2">
                  <div>{key.label}</div>
                  <div className="font-mono text-[11px] text-muted">{key.id}</div>
                </td>
                <td>{key.scopes.join(', ')}</td>
                <td>{dateFmt.format(new Date(key.expiresAt))}</td>
                <td>{key.lastUsedAt ? dateFmt.format(new Date(key.lastUsedAt)) : '—'}</td>
                <td className="text-right">
                  {key.revokedAt ? (
                    <Badge tone="neutral">{k.revoked}</Badge>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => void revoke(key.id)}>
                      {k.revoke}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
