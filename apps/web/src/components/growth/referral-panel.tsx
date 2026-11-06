'use client';

import type { MyFeesDto, ReferralSummaryDto } from '@platform/shared';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import type { Dictionary } from '@/i18n';
import { api } from '@/lib/api';

/** Fee tier and referral link for the signed-in account (ADR-0018). */
export function ReferralPanel({ t, wallet }: { t: Dictionary; wallet: boolean }) {
  const f = t.growth;
  const [fees, setFees] = useState<MyFeesDto | null>(null);
  const [ref, setRef] = useState<ReferralSummaryDto | null>(null);
  const load = useCallback(() => {
    api<MyFeesDto>('/v1/me/fees')
      .then(setFees)
      .catch(() => setFees(null));
    api<ReferralSummaryDto>('/v1/me/referrals')
      .then(setRef)
      .catch(() => setRef(null));
  }, []);
  useEffect(load, [load]);
  const link =
    ref?.code && typeof window !== 'undefined'
      ? `${window.location.origin}/connect?ref=${ref.code}`
      : null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card className="p-6" data-testid="fee-tier-card">
        <CardTitle>{f.yourTier}</CardTitle>
        <p className="mt-3 text-3xl font-semibold">{fees?.tier ?? 0}</p>
        <CardDescription>
          {f.volume30d}: <span className="font-mono">{fees?.volume30d ?? '0'}</span>
        </CardDescription>
      </Card>
      <Card className="p-6" data-testid="referral-card">
        <CardTitle>{f.referralsTitle}</CardTitle>
        <CardDescription>{f.referralsIntro}</CardDescription>
        {link ? (
          <p className="mt-3 break-all font-mono text-xs" data-testid="referral-link">
            {link}
          </p>
        ) : (
          wallet && (
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              onClick={() =>
                void api('/v1/me/referrals/code', { method: 'POST' }).then(load, () => undefined)
              }
            >
              {f.createCode}
            </Button>
          )
        )}
        <p className="mt-3 text-sm">
          {f.referred}: {ref?.referred ?? 0}
        </p>
        {ref?.earnings.map((e) => (
          <p key={e.asset} className="text-sm">
            {f.earnings}: <span className="font-mono">{e.amount}</span> {e.asset}
          </p>
        ))}
      </Card>
    </div>
  );
}
