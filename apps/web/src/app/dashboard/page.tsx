import type { Metadata } from 'next';
import { Dashboard } from '@/components/dashboard/dashboard';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.dashboard.title };

export default function DashboardPage() {
  return <Dashboard t={t} />;
}
