import type { Metadata } from 'next';
import { Dashboard } from '@/components/dashboard/dashboard';
import { getDictionary } from '@/i18n';
import { resolveLocale, type LocaleParams } from '@/i18n/server';

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return { title: getDictionary(await resolveLocale(params)).dashboard.title };
}

export default async function DashboardPage({ params }: LocaleParams) {
  const locale = await resolveLocale(params);
  return <Dashboard locale={locale} t={getDictionary(locale)} />;
}
