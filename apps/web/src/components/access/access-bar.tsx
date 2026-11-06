'use client';

import type { AccessStatusDto, MyAccessStatusDto } from '@platform/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { locationName } from './place-names';

type Status = (AccessStatusDto & Partial<MyAccessStatusDto>) & { signedIn: boolean };

async function fetchStatus(): Promise<Status | null> {
  try {
    return { ...(await api<MyAccessStatusDto>('/v1/me/access')), signedIn: true };
  } catch (e) {
    // 401: signed out. 451: the whole API refuses this location (block_all mode).
    if (!(e instanceof ApiError) || (e.status !== 401 && e.status !== 451)) return null;
    try {
      return { ...(await api<AccessStatusDto>('/v1/access')), signedIn: false };
    } catch {
      // The notice is informational; the server still enforces the policy.
      return null;
    }
  }
}

/**
 * Access policy notices (ADR-0022): restricted region, sanctioned wallet and
 * the terms-of-use acceptance prompt. The server enforces all of these; this
 * only explains them and records acceptance.
 */
export function AccessBar({ t }: { t: Dictionary['access'] }) {
  const [s, setS] = useState<Status | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    let active = true;
    void fetchStatus().then((v) => {
      if (active && v) setS(v);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!s) return null;

  // block_all (ADR-0024): like the reference venue, a restricted location gets
  // nothing but this notice. The terms page stays readable.
  if (s.regionRestricted && s.restrictedMode === 'block_all' && pathname !== '/terms') {
    const where = locationName(s.country, s.subdivision);
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4 backdrop-blur"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="region-blocked-title"
        data-testid="region-blocked"
      >
        <div className="max-w-md rounded-lg border border-border bg-surface p-6 shadow-lg">
          <h2 id="region-blocked-title" className="text-lg font-semibold">
            {t.blockedTitle}
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted">{t.blockedBody}</p>
          {where ? (
            <p className="mt-3 text-sm">
              {t.detected}: <strong>{where}</strong>
            </p>
          ) : null}
          <p className="mt-3 text-sm leading-6 text-muted">{t.blockedFunds}</p>
          <p className="mt-4 text-sm">
            <Link href="/terms" className="underline">
              {t.termsLink}
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/v1/me/terms/accept', { method: 'POST', body: { version: s.termsVersion } });
      const next = await fetchStatus();
      if (next) setS(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-2 px-4 pt-3 sm:px-6" data-testid="access-bar">
      {s.sanctioned ? (
        <Alert tone="error">
          <strong className="block">{t.sanctionedTitle}</strong>
          {t.sanctionedBody}
        </Alert>
      ) : null}
      {s.regionRestricted ? (
        <Alert tone="warning" data-testid="region-restricted">
          <strong className="block">{t.regionTitle}</strong>
          {t.regionBody}
          {locationName(s.country, s.subdivision) ? (
            <span className="mt-1 block text-xs">
              {t.detected}: {locationName(s.country, s.subdivision)}
            </span>
          ) : null}
        </Alert>
      ) : null}
      {s.signedIn && !s.sanctioned && s.termsAccepted === false ? (
        <Alert tone="info" data-testid="terms-prompt">
          <strong className="block">{t.termsTitle}</strong>
          <p className="mt-1 text-muted">{t.termsBody}</p>
          <label className="mt-3 flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              data-testid="terms-checkbox"
            />
            <span>
              {t.termsCheckbox}{' '}
              <Link href="/terms" className="underline">
                {t.termsLink}
              </Link>
            </span>
          </label>
          <div className="mt-3 flex items-center gap-3">
            <Button
              size="sm"
              disabled={!checked || busy}
              onClick={() => void accept()}
              data-testid="terms-accept"
            >
              {busy ? t.accepting : t.accept}
            </Button>
            {error ? <span className="text-negative">{error}</span> : null}
          </div>
        </Alert>
      ) : null}
    </div>
  );
}
