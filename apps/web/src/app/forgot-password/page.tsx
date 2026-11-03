import type { Metadata } from 'next';
import { ForgotPasswordForm } from '@/components/auth/token-forms';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.auth.forgotTitle };

export default function Page() {
  return <ForgotPasswordForm t={t.auth} />;
}
