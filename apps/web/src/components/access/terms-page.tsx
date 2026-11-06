'use client';

import type { AccessStatusDto } from '@platform/shared';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import type { Dictionary } from '@/i18n';
import { api } from '@/lib/api';

/** Terms of use, with the deployment's live terms version and restricted list. */
export function TermsPage({ t }: { t: Dictionary['terms'] }) {
  const [s, setS] = useState<AccessStatusDto | null>(null);
  useEffect(() => {
    api<AccessStatusDto>('/v1/access')
      .then(setS)
      .catch(() => setS(null));
  }, []);
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-12 sm:px-6" data-testid="terms-page">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{t.title}</h1>
        {s ? (
          <p className="mt-2 text-sm text-muted">
            {t.version}: <span className="font-mono">{s.termsVersion}</span>
          </p>
        ) : null}
      </div>
      <Alert tone="warning">{t.draft}</Alert>
      {t.sections.map((sec) => (
        <section key={sec.heading}>
          <h2 className="text-lg font-semibold">{sec.heading}</h2>
          <p className="mt-2 text-sm leading-6 text-muted">{sec.body}</p>
        </section>
      ))}
      <Card className="p-6">
        <h2 className="text-lg font-semibold">{t.restrictedHeading}</h2>
        <p className="mt-2 font-mono text-sm" data-testid="restricted-list">
          {s && s.restrictedCountries.length > 0
            ? s.restrictedCountries.join(', ')
            : t.restrictedNone}
        </p>
      </Card>
    </div>
  );
}
