import type { Metadata } from 'next';
import { LoginForm } from '@/components/auth/login-form';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.auth.loginTitle };

export default function Page() {
  return <LoginForm t={t.auth} />;
}
