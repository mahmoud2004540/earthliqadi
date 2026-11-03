import type { Metadata } from 'next';
import { WalletConnect } from '@/components/auth/wallet-connect';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.wallet.title };

export default function ConnectPage() {
  return <WalletConnect t={t} />;
}
