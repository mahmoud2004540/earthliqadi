import type { Metadata } from 'next';
import { ResetPasswordForm } from '@/components/auth/token-forms';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.auth.resetTitle };

export default function Page() {
  return <ResetPasswordForm t={t.auth} />;
}
