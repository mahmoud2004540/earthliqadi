import type { Metadata } from 'next';
import { VaultList } from '@/components/vaults/vaults';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.vaults.title };

export default function Page() {
  return <VaultList t={t} />;
}
