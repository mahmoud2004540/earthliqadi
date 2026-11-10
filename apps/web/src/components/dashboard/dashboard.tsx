'use client';

import type { CurrentUserDto } from '@platform/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription } from '@/components/ui/card';
import { useEmailWallet } from '@/components/wallet/email-wallet';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { InboxPanel, SupportPanel } from './account-panels';
import { AccountOverview } from './account-overview';
import { StatementsPanel } from './statements-panel';
import { ReferralPanel } from '@/components/growth/referral-panel';
import { ApiKeysPanel } from './api-keys-panel';
import { SubAccountsPanel } from './sub-accounts-panel';
import { SecurityPanel } from './security-panel';
import { VaultPanel } from './vault-panel';
import { WalletPanel } from './wallet-panel';

export function Dashboard({ t }: { t: Dictionary }) {
  const router = useRouter();
  const [user, setUser] = useState<CurrentUserDto | null>(null);
  type Tab = 'overview' | 'wallet' | 'statements' | 'api' | 'support' | 'inbox' | 'security';
  const [tab, setTab] = useState<Tab>('overview');

  const [version, setVersion] = useState(0);
  const email = useEmailWallet();
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let active = true;
    api<CurrentUserDto>('/v1/me')
      .then((me) => {
        if (active) setUser(me);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) router.replace('/login');
      });
    return () => {
      active = false;
    };
  }, [router, version]);

  async function logout() {
    await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    // Also end the email-wallet session, so the next person on this browser starts clean.
    await email.logout().catch(() => undefined);
    router.replace('/login');
    router.refresh();
  }

  const d = t.dashboard;
  if (!user) return <p className="mx-auto max-w-5xl px-4 py-16 text-muted sm:px-6">{d.loading}</p>;

  const dateFmt = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{d.title}</h1>
          <p className="mt-1 text-sm text-muted">
            {d.welcome}{' '}
            <span className="text-foreground" dir="ltr">
              {user.email ?? user.walletAddress}
            </span>
          </p>
        </div>
        <div className="flex gap-2">
          {user.permissions.some(
            (p) => !['account:self:read', 'account:self:manage', 'trading:trade'].includes(p),
          ) && (
            <Button asChild variant="outline" size="sm">
              <Link href="/admin" data-testid="admin-link">
                {d.adminConsole}
              </Link>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={logout}>
            {t.nav.logout}
          </Button>
        </div>
      </div>

      <div role="tablist" className="mt-8 flex gap-1 overflow-x-auto border-b border-border">
        {(['overview', 'wallet', 'statements', 'api', 'support', 'inbox', 'security'] as const).map(
          (key) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                '-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium',
                tab === key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted hover:text-foreground',
              )}
            >
              {
                {
                  overview: d.overview,
                  wallet: d.balancesTitle,
                  statements: d.statementsTab,
                  api: d.apiTab,
                  support: d.supportTab,
                  inbox: d.inboxTab,
                  security: d.securityTab,
                }[key]
              }
            </button>
          ),
        )}
      </div>

      {tab === 'wallet' ? (
        <div className="mt-8">
          <WalletPanel t={t} />
          <div className="mt-6">
            <VaultPanel t={t} walletAddress={user.walletAddress} />
          </div>
        </div>
      ) : tab === 'statements' ? (
        <div className="mt-8">
          <StatementsPanel t={t} />
        </div>
      ) : tab === 'api' ? (
        <div className="mt-8">
          <ApiKeysPanel t={t} walletAddress={user.walletAddress} />
          {user.walletAddress && (
            <div className="mt-6">
              <SubAccountsPanel t={t} />
            </div>
          )}
        </div>
      ) : tab === 'support' ? (
        <div className="mt-8">
          <SupportPanel t={t} />
        </div>
      ) : tab === 'inbox' ? (
        <div className="mt-8">
          <InboxPanel t={t} />
        </div>
      ) : tab === 'overview' ? (
        <div className="mt-8 space-y-8">
          <AccountOverview t={t} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={d.accountStatus} value={user.status.replace('_', ' ')} tone="positive" />
            <Stat label={d.accountType} value={user.accountType} />
            {user.walletAddress && !user.email ? (
              <Stat label={d.signInMethod} value={d.walletSignature} tone="positive" />
            ) : (
              <Stat
                label={d.twoFactor}
                value={user.mfaEnabled ? d.enabled : d.disabled}
                tone={user.mfaEnabled ? 'positive' : 'warning'}
              />
            )}
            <Stat label={d.memberSince} value={dateFmt.format(new Date(user.createdAt))} />
          </div>
          <ReferralPanel t={t} wallet={user.walletAddress !== null} />
        </div>
      ) : (
        <SecurityPanel user={user} t={t} onChange={reload} />
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
