import type { Metadata } from 'next';
import { InfoPage } from '@/components/info-page';
import { getDictionary } from '@/i18n';
import { resolveLocale, type LocaleParams } from '@/i18n/server';

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return { title: getDictionary(await resolveLocale(params)).pages.trade.title };
}

export default async function Page({ params }: LocaleParams) {
  const t = getDictionary(await resolveLocale(params));
  return <InfoPage {...t.pages.trade} />;
}
