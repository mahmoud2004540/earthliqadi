import type { Metadata } from 'next';
import { FeeSchedule } from '@/components/growth/fee-schedule';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.pages.fees.title };

export default function Page() {
  return <FeeSchedule t={t} />;
}
