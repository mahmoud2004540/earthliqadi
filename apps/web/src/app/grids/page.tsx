import type { Metadata } from 'next';
import { GridMarketplace } from '@/components/grids/grid-marketplace';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.grids.title };

export default function Page() {
  return <GridMarketplace t={t} />;
}
