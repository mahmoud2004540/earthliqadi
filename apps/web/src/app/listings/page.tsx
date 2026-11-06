import type { Metadata } from 'next';
import { ListingBoard } from '@/components/listings/listing-board';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.listings.title };

export default function Page() {
  return <ListingBoard t={t} />;
}
