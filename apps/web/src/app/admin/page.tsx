import type { Metadata } from 'next';
import { AdminConsole } from '@/components/admin/admin-console';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.admin.title, robots: { index: false } };

/** Authorization is enforced by the API on every request; this page holds no data itself. */
export default function AdminPage() {
  return <AdminConsole t={t} />;
}
