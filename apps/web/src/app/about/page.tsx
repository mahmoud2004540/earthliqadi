import type { Metadata } from 'next';
import { InfoPage } from '@/components/info-page';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.pages.about.title };

export default function Page() {
  return <InfoPage {...t.pages.about} />;
}
