import type { Metadata } from 'next';
import { TermsPage } from '@/components/access/terms-page';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.terms.title };

export default function Page() {
  return <TermsPage t={t.terms} />;
}
