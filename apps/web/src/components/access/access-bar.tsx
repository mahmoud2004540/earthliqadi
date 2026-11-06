'use client';

import type { AccessStatusDto, MyAccessStatusDto } from '@platform/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';

type Status = (AccessStatusDto & Partial<MyAccessStatusDto>) & { signedIn: boolean };

async function fetchStatus(): Promise<Status | null> {
  try {
    return { ...(await api<MyAccessStatusDto>('/v1/me/access')), signedIn: true };
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) return null;
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
