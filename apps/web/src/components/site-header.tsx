import Link from 'next/link';
import type { Dictionary } from '@/i18n';
import { brandName } from '@/lib/utils';
import { HeaderAuth } from './header-auth';

export function SiteHeader({ t }: { t: Dictionary }) {
  const links = [
    { href: 'markets', label: t.nav.markets },
    { href: 'trade', label: t.nav.trade },
    { href: 'fees', label: t.nav.fees },
    { href: 'vaults', label: t.nav.vaults },
    { href: 'leaderboard', label: t.nav.leaderboard },
    { href: 'security', label: t.nav.security },
    { href: 'trust', label: t.nav.trust },
    { href: 'api-docs', label: t.nav.api },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link href={'/'} className="flex items-center gap-2 font-semibold tracking-tight">
          <span
            aria-hidden
            className="grid size-7 place-items-center rounded-md bg-primary text-sm text-white"
          >
            {brandName.charAt(0)}
          </span>
          {brandName}
        </Link>
        <nav aria-label="Primary" className="hidden flex-1 items-center gap-1 lg:flex">
          {links.map((l) => (
            <Link
              key={l.href}
              href={`/${l.href}`}
              className="rounded-md px-3 py-2 text-sm text-muted transition-colors hover:text-foreground"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ms-auto flex items-center gap-2">
          <HeaderAuth t={t.nav} />
        </div>
      </div>
      <nav
        aria-label={t.nav.menu}
        className="flex gap-1 overflow-x-auto border-t border-border px-4 py-2 lg:hidden"
      >
        {links.map((l) => (
          <Link
            key={l.href}
            href={`/${l.href}`}
            className="shrink-0 rounded-md px-3 py-1.5 text-sm text-muted hover:bg-surface hover:text-foreground"
          >
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
