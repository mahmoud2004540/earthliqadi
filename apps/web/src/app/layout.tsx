import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AccessBar } from '@/components/access/access-bar';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { getDictionary } from '@/i18n';
import { brandName } from '@/lib/utils';
import './globals.css';

const t = getDictionary();

export const metadata: Metadata = {
  title: { default: brandName, template: `%s · ${brandName}` },
  description: t.meta.description,
  // Pre-launch: keep the site out of search indexes.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#10151D', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
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
        <SiteHeader t={t} />
        <AccessBar t={t.access} />
        <main id="main">{children}</main>
        <SiteFooter t={t} />
      </body>
    </html>
  );
}
