import type { Metadata } from 'next';
import { VerifyEmail } from '@/components/auth/token-forms';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.auth.verifyTitle };

export default function Page() {
  return <VerifyEmail t={t.auth} />;
}
