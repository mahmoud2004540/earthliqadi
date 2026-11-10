'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { privyAppId } from '@/lib/privy-config';

export { EmailWalletError, useEmailWallet, type EmailWallet } from './email-wallet-context';

// Downloaded only when email wallets are configured.
const PrivyBridge = dynamic(() => import('./privy-bridge'), { ssr: false, loading: () => null });

/** Email wallets (ADR-0035). Without a Privy app id, the page is unchanged. */
export function EmailWalletProvider({ children }: { children: ReactNode }) {
  const appId = privyAppId();
  if (!appId) return <>{children}</>;
  return <PrivyBridge appId={appId}>{children}</PrivyBridge>;
}
