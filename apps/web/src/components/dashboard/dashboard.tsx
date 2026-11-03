'use client';

import type { CurrentUserDto } from '@platform/shared';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { SecurityPanel } from './security-panel';
import { WalletPanel } from './wallet-panel';

export function Dashboard({ locale, t }: { locale: string; t: Dictionary }) {
  const router = useRouter();
  const [user, setUser] = useState<CurrentUserDto | null>(null);
  const [tab, setTab] = useState<'overview' | 'wallet' | 'security'>('overview');

  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let active = true;
    api<CurrentUserDto>('/v1/me')
      .then((me) => {
        if (active) setUser(me);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) router.replace(`/${locale}/login`);
      });
    return () => {
      active = false;
    };
  }, [locale, router, version]);

  async function logout() {
    await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace(`/${locale}/login`);
    router.refresh();
  }

  const d = t.dashboard;
  if (!user) return <p className="mx-auto max-w-5xl px-4 py-16 text-muted sm:px-6">{d.loading}</p>;

  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{d.title}</h1>
          <p className="mt-1 text-sm text-muted">
            {d.welcome}{' '}
            <span className="text-foreground" dir="ltr">
              {user.email}
            </span>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={logout}>
          {t.nav.logout}
        </Button>
      </div>

      <div role="tablist" className="mt-8 flex gap-1 border-b border-border">
        {(['overview', 'wallet', 'security'] as const).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm font-medium',
              tab === key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted hover:text-foreground',
            )}
          >
            {key === 'overview' ? d.overview : key === 'wallet' ? d.balancesTitle : d.securityTab}
          </button>
        ))}
      </div>

      {tab === 'wallet' ? (
        <div className="mt-8">
          <WalletPanel t={t} locale={locale} />
        </div>
      ) : tab === 'overview' ? (
        <div className="mt-8 space-y-8">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={d.accountStatus} value={user.status.replace('_', ' ')} tone="positive" />
            <Stat label={d.accountType} value={user.accountType} />
            <Stat
              label={d.twoFactor}
              value={user.mfaEnabled ? d.enabled : d.disabled}
              tone={user.mfaEnabled ? 'positive' : 'warning'}
            />
            <Stat label={d.memberSince} value={dateFmt.format(new Date(user.createdAt))} />
          </div>
          <section>
            <h2 className="text-lg font-semibold">{d.modulesTitle}</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {d.modules.map((m) => (
                <Card key={m.name} className="flex items-center justify-between p-4">
                  <CardTitle className="text-sm font-medium">{m.name}</CardTitle>
                  <Badge>
                    {t.status.planned} · {t.status.phase} {m.phase}
                  </Badge>
                </Card>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <SecurityPanel user={user} t={t} locale={locale} onChange={reload} />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'warning';
}) {
  return (
    <Card className="p-4">
      <CardDescription className="mt-0">{label}</CardDescription>
      <p
        className={cn(
          'mt-2 font-semibold',
          tone === 'positive' && 'text-positive',
          tone === 'warning' && 'text-warning',
        )}
      >
        {value}
      </p>
    </Card>
  );
}
