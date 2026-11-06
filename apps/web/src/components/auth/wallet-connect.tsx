'use client';

import type { LoginResultDto } from '@platform/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { Dictionary } from '@/i18n';
import { api } from '@/lib/api';
import { AuthShell, errorMessage } from './shared';

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function provider(): Eip1193Provider | null {
  const w = window as unknown as { ethereum?: Eip1193Provider };
  return w.ethereum ?? null;
}

function toHex(text: string): string {
  return `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Sign-In with Ethereum (EIP-4361, ADR-0013). The wallet signs a human-readable
 * message bound to this site and a single-use nonce. No transaction, no gas,
 * no email and no identity documents. The account is created on first sign-in.
 */
export function WalletConnect({ t }: { t: Dictionary }) {
  const w = t.wallet;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasWallet = typeof window !== 'undefined' && provider() !== null;

  async function connect() {
    const eth = provider();
    if (!eth) {
      setError(w.noWallet);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const [address] = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
      if (!address) throw new Error(w.noAccount);
      const chainHex = (await eth.request({ method: 'eth_chainId' })) as string;
      const n = await api<{ nonce: string; domain: string; uri: string }>('/v1/auth/wallet/nonce');
      const message = [
        `${n.domain} wants you to sign in with your Ethereum account:`,
        address,
        '',
        w.statement,
        '',
        `URI: ${n.uri}`,
        'Version: 1',
        `Chain ID: ${parseInt(chainHex, 16) || 1}`,
        `Nonce: ${n.nonce}`,
        `Issued At: ${new Date().toISOString()}`,
      ].join('\n');
      const signature = (await eth.request({
        method: 'personal_sign',
        params: [toHex(message), address],
      })) as string;
      // A referral link (?ref=code) only counts when this sign-in creates the account.
      const ref = new URLSearchParams(window.location.search).get('ref');
      const referralCode = ref && /^[a-z0-9]{6,16}$/i.test(ref) ? ref.toLowerCase() : undefined;
      const result = await api<LoginResultDto>('/v1/auth/wallet/login', {
        method: 'POST',
        body: { message, signature, ...(referralCode ? { referralCode } : {}) },
      });
      if (result.status === 'authenticated') {
        router.replace('/dashboard');
        router.refresh();
      }
    } catch (err) {
      const rejected = (err as { code?: number }).code === 4001;
      setError(rejected ? w.rejected : errorMessage(t.auth, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={w.title}>
      <div className="space-y-4" data-testid="wallet-connect">
        <p className="text-sm text-muted">{w.intro}</p>
        {error && <Alert tone="error">{error}</Alert>}
        <Button className="w-full" onClick={() => void connect()} disabled={busy}>
          {busy ? w.waiting : w.connect}
        </Button>
        {!hasWallet && <p className="text-xs text-muted">{w.noWallet}</p>}
        <ul className="list-disc space-y-1 ps-5 text-xs text-muted">
          {w.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <p className="text-center text-xs text-muted">
          <Link href="/login" className="hover:underline">
            {w.staff}
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
