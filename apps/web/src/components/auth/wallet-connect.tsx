'use client';

import type { LoginResultDto } from '@platform/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { Dictionary } from '@/i18n';
import { EmailWalletError, useEmailWallet } from '@/components/wallet/email-wallet';
import { api } from '@/lib/api';
import { injectedProvider, toHex, type Eip1193 } from '@/lib/wallet';
import { AuthShell, errorMessage } from './shared';

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
  const email = useEmailWallet();
  const hasWallet = typeof window !== 'undefined' && injectedProvider() !== null;

  /**
   * Same sign-in for both kinds of wallet: the wallet signs the SIWE message.
   * For an email wallet, Privy shows the message and asks the user to confirm.
   */
  async function signIn(getWallet: () => Promise<{ eth: Eip1193; address: string }>) {
    setBusy(true);
    setError(null);
    try {
      const { eth, address } = await getWallet();
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
      setError(
        err instanceof EmailWalletError
          ? err.reason === 'cancelled'
            ? w.emailCancelled
            : w.emailUnavailable
          : rejected
            ? w.rejected
            : errorMessage(t.auth, err),
      );
    } finally {
      setBusy(false);
    }
  }

  function connectExtension() {
    const eth = injectedProvider();
    if (!eth) {
      setError(w.noWallet);
      return;
    }
    void signIn(async () => {
      const [address] = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
      if (!address) throw new Error(w.noAccount);
      return { eth, address };
    });
  }

  function connectEmail() {
    void signIn(async () => {
      const r = await email.connect();
      return { eth: r.provider, address: r.address };
    });
  }

  return (
    <AuthShell title={w.title}>
      <div className="space-y-4" data-testid="wallet-connect">
        <p className="text-sm text-muted">{w.intro}</p>
        {error && <Alert tone="error">{error}</Alert>}
        <Button className="w-full" onClick={connectExtension} disabled={busy}>
          {busy ? w.waiting : w.connect}
        </Button>
        {!hasWallet && <p className="text-xs text-muted">{w.noWallet}</p>}
        {email.available && (
          <div className="space-y-2" data-testid="email-wallet">
            <Button className="w-full" variant="outline" onClick={connectEmail} disabled={busy}>
              {w.email}
            </Button>
            <p className="text-xs text-muted">{w.emailHelp}</p>
          </div>
        )}
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
