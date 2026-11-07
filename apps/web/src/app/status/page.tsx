import type { Metadata } from 'next';
import { StatusPage } from '@/components/status/status-page';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.statusPage.pageTitle };

export default function Page() {
  return <StatusPage t={t} />;
}
