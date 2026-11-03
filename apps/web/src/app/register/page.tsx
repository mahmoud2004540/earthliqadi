import type { Metadata } from 'next';
import { RegisterForm } from '@/components/auth/register-form';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.auth.registerTitle };

export default function Page() {
  return <RegisterForm t={t.auth} riskLabel={t.footer.risk} />;
}
