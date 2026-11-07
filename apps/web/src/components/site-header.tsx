import Link from 'next/link';
import type { Dictionary } from '@/i18n';
import { brandName } from '@/lib/utils';
import { HeaderAuth } from './header-auth';

export function SiteHeader({ t }: { t: Dictionary }) {
  // Primary destinations stay visible; the rest sit under "More" so the bar stays short.
  const primary = [
    { href: 'markets', label: t.nav.markets },
    { href: 'trade', label: t.nav.trade },
    { href: 'vaults', label: t.nav.vaults },
    { href: 'grids', label: t.nav.grids },
    { href: 'leaderboard', label: t.nav.leaderboard },
  ];
  const more = [
    { href: 'fees', label: t.nav.fees },
    { href: 'listings', label: t.nav.listings },
    { href: 'proof', label: t.nav.proof },
    { href: 'security', label: t.nav.security },
    { href: 'trust', label: t.nav.trust },
    { href: 'api-docs', label: t.nav.api },
  ];
  const links = [...primary, ...more];
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
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
          {primary.map((l) => (
            <Link
              key={l.href}
              href={`/${l.href}`}
              className="rounded-md px-3 py-2 text-sm text-muted transition-colors hover:text-foreground"
            >
              {l.label}
            </Link>
          ))}
          <details className="group relative" data-testid="nav-more">
            <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md px-3 py-2 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
              {t.nav.more}
              <span aria-hidden className="text-[10px] transition-transform group-open:rotate-180">
                ▾
              </span>
            </summary>
            <div className="absolute start-0 top-full z-50 mt-1 min-w-48 rounded-md border border-border bg-surface p-1 shadow-lg">
              {more.map((l) => (
                <Link
                  key={l.href}
                  href={`/${l.href}`}
                  className="block rounded px-3 py-2 text-sm text-muted hover:bg-surface-raised hover:text-foreground"
                >
                  {l.label}
                </Link>
              ))}
            </div>
          </details>
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
