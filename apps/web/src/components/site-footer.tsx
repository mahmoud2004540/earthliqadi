import Link from 'next/link';
import type { Dictionary } from '@/i18n';
import { brandName } from '@/lib/utils';

export function SiteFooter({ t }: { t: Dictionary }) {
  const col = (heading: string, links: { href: string; label: string }[]) => (
    <div>
      <h2 className="text-sm font-semibold text-foreground">{heading}</h2>
      <ul className="mt-3 space-y-2">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={`/${l.href}`} className="text-sm text-muted hover:text-foreground">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <footer className="mt-24 border-t border-border">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-4">
        <div>
          <p className="font-semibold">{brandName}</p>
          <p className="mt-2 text-sm text-muted">{t.footer.tagline}</p>
        </div>
        {col(t.footer.company, [
          { href: 'about', label: t.footer.about },
          { href: 'contact', label: t.footer.contact },
          { href: 'trust', label: t.nav.trust },
        ])}
        {col(t.footer.resources, [
          { href: 'security', label: t.nav.security },
          { href: 'fees', label: t.nav.fees },
          { href: 'api-docs', label: t.nav.api },
        ])}
        {col(t.footer.legalHeading, [
          { href: 'legal', label: t.footer.legal },
          { href: 'risk', label: t.footer.risk },
        ])}
      </div>
      <div className="border-t border-border">
        <p className="mx-auto max-w-7xl px-4 py-6 text-xs leading-relaxed text-muted sm:px-6">
          {t.footer.disclaimer}
        </p>
      </div>
    </footer>
  );
}
