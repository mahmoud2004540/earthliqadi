import type { ReactNode } from 'react';
import { EmailWalletProvider } from '@/components/wallet/email-wallet';

// Email wallets (ADR-0035) are loaded only on the pages that sign.
export default function Layout({ children }: { children: ReactNode }) {
  return <EmailWalletProvider>{children}</EmailWalletProvider>;
}
