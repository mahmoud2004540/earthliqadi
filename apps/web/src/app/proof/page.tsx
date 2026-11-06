import type { Metadata } from 'next';
import { ProofPage } from '@/components/growth/proof';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.proof.title };

export default function Page() {
  return <ProofPage t={t} />;
}
