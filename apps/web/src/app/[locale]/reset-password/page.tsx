import type { Metadata } from 'next';
import { ResetPasswordForm } from '@/components/auth/token-forms';
import { getDictionary } from '@/i18n';
import { resolveLocale, type LocaleParams } from '@/i18n/server';

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return { title: getDictionary(await resolveLocale(params)).auth.resetTitle };
}

export default async function Page({ params }: LocaleParams) {
  const locale = await resolveLocale(params);
  const t = getDictionary(locale);
  return <ResetPasswordForm locale={locale} t={t.auth} />;
}
