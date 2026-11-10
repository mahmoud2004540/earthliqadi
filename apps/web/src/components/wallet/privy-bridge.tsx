'use client';

import {
  PrivyErrorCode,
  PrivyProvider,
  useExportWallet,
  useLogin,
  useLogout,
  usePrivy,
  useWallets,
} from '@privy-io/react-auth';
import { baseSepolia } from 'viem/chains';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { emailWalletChains } from '@/lib/privy-config';
import { setEmbeddedWallet, type Eip1193 } from '@/lib/wallet';
import { EmailWalletContext, EmailWalletError, type EmailWallet } from './email-wallet-context';

/** Privy is loaded only when an app id is configured (ADR-0035). */
export default function PrivyBridge({ appId, children }: { appId: string; children: ReactNode }) {
  const chains = emailWalletChains();
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email'],
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        defaultChain: chains.find((c) => c.id === baseSepolia.id) ?? chains[0],
        supportedChains: chains,
        appearance: { theme: 'dark', showWalletLoginFirst: false },
      }}
    >
      <Bridge>{children}</Bridge>
    </PrivyProvider>
  );
}

type Waiter = {
  resolve: (w: { address: string; provider: Eip1193 }) => void;
  reject: (e: unknown) => void;
};

function Bridge({ children }: { children: ReactNode }) {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { logout } = useLogout();
  const { exportWallet } = useExportWallet();
  const waiter = useRef<Waiter | null>(null);
  const { login } = useLogin({
    onError: (err) => {
      waiter.current?.reject(
        new EmailWalletError(
          err === PrivyErrorCode.USER_EXITED_AUTH_FLOW ? 'cancelled' : 'unavailable',
        ),
      );
      waiter.current = null;
    },
  });

  // Only the wallet Privy created; an extension wallet seen by Privy is ignored.
  const wallet = authenticated ? wallets.find((w) => w.walletClientType === 'privy') : undefined;

  useEffect(() => {
    if (!wallet) {
      setEmbeddedWallet(null);
      return;
    }
    setEmbeddedWallet({
      address: wallet.address,
      provider: () => wallet.getEthereumProvider(),
      switchChain: (id) => wallet.switchChain(id),
    });
    const w = waiter.current;
    if (w) {
      waiter.current = null;
      wallet
        .getEthereumProvider()
        .then((provider) => w.resolve({ address: wallet.address, provider }), w.reject);
    }
    return () => setEmbeddedWallet(null);
  }, [wallet]);

  const value = useMemo<EmailWallet>(
    () => ({
      available: true,
      address: wallet?.address ?? null,
      connect: () =>
        new Promise((resolve, reject) => {
          if (!ready) {
            reject(new EmailWalletError('unavailable'));
            return;
          }
          if (wallet) {
            wallet
              .getEthereumProvider()
              .then((provider) => resolve({ address: wallet.address, provider }), reject);
            return;
          }
          const w: Waiter = { resolve, reject };
          waiter.current = w;
          // Never leave the page waiting if Privy cannot create the wallet.
          setTimeout(() => {
            if (waiter.current !== w) return;
            waiter.current = null;
            reject(new EmailWalletError('unavailable'));
          }, 180_000);
          // Signed in to Privy already: the wallet is being created, the effect resolves.
          if (!authenticated) login();
        }),
      logout: () => (authenticated ? logout() : Promise.resolve()),
      exportKey: () => (wallet ? exportWallet({ address: wallet.address }) : Promise.resolve()),
    }),
    [ready, authenticated, wallet, login, logout, exportWallet],
  );

  return <EmailWalletContext.Provider value={value}>{children}</EmailWalletContext.Provider>;
}
