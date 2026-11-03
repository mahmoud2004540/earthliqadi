import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { LOCALES, directionFor, getDictionary } from '@/i18n';
import { resolveLocale, type LocaleParams } from '@/i18n/server';
import { brandName } from '@/lib/utils';
import '../globals.css';

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const t = getDictionary(await resolveLocale(params));
  return {
    title: { default: brandName, template: `%s · ${brandName}` },
    description: t.meta.description,
    // Pre-launch: keep the site out of search indexes.
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = { themeColor: '#10151D', colorScheme: 'dark' };

export default async function LocaleLayout({
  children,
  params,
}: LocaleParams & { children: ReactNode }) {
  const locale = await resolveLocale(params);
  const t = getDictionary(locale);
  return (
    <html lang={locale} dir={directionFor(locale)}>
      <body className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50"
        >
          Skip to content
        </a>
        <div className="bg-warning/10 px-4 py-2 text-center text-xs font-medium text-warning">
          {t.banner}
        </div>
        <SiteHeader locale={locale} t={t} />
        <main id="main">{children}</main>
        <SiteFooter locale={locale} t={t} />
      </body>
    </html>
  );
}
