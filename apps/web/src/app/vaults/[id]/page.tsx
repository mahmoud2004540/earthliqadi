import type { Metadata } from 'next';
import { VaultDetail } from '@/components/vaults/vaults';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.vaults.title };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VaultDetail t={t} id={id} />;
}
