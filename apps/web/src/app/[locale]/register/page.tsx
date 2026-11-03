import type { Metadata } from 'next';
import { RegisterForm } from '@/components/auth/register-form';
import { getDictionary } from '@/i18n';
import { resolveLocale, type LocaleParams } from '@/i18n/server';

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return { title: getDictionary(await resolveLocale(params)).auth.registerTitle };
}

export default async function Page({ params }: LocaleParams) {
  const locale = await resolveLocale(params);
  const t = getDictionary(locale);
  return <RegisterForm locale={locale} t={t.auth} riskLabel={t.footer.risk} />;
}
