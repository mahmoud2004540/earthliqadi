'use client';

import type { ComponentState, StatusDto } from '@platform/shared';
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import type { Dictionary } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const TONE: Record<ComponentState, string> = {
  operational: 'bg-positive',
  degraded: 'bg-warning',
  outage: 'bg-negative',
};

/** Public status page (ADR-0030): live component states and incident reports. Refreshes every 30 s. */
export function StatusPage({ t }: { t: Dictionary }) {
  const s = t.statusPage;
  const [data, setData] = useState<StatusDto | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () =>
      api<StatusDto>('/v1/status')
        .then((d) => {
          if (!active) return;
          setData(d);
          setFailed(false);
        })
        .catch(() => active && setFailed(true));
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const fmt = new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6" data-testid="status-page">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{s.pageTitle}</h1>
        <p className="mt-2 text-sm text-muted">{s.intro}</p>
      </div>
      {failed && !data && <Card className="p-5 text-sm text-negative">{s.unreachable}</Card>}
      {data && (
        <>
          <Card className="flex items-center gap-3 p-5" data-testid="status-overall">
            <span aria-hidden className={cn('size-3 rounded-full', TONE[data.overall])} />
            <p className="text-lg font-semibold">{s.overall[data.overall]}</p>
            <p className="ms-auto text-xs text-muted">
              {s.checked} {fmt.format(new Date(data.generatedAt))} UTC
            </p>
          </Card>
          <section>
            <h2 className="text-lg font-semibold">{s.componentsTitle}</h2>
            <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
              {data.components.map((c) => (
                <li
                  key={c.key}
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                  data-testid="status-component"
                >
                  <span aria-hidden className={cn('size-2.5 rounded-full', TONE[c.state])} />
                  <span className="font-medium">{s.components[c.key]}</span>
                  <span className="text-sm text-muted">{c.detail}</span>
                  <span className="ms-auto text-xs text-muted">
                    {s.state[c.state]}
                    {c.lastSeen ? ` · ${s.lastSeen} ${fmt.format(new Date(c.lastSeen))} UTC` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="text-lg font-semibold">{s.incidentsTitle}</h2>
            {data.incidents.length === 0 ? (
              <p className="mt-3 text-sm text-muted">{s.noIncidents}</p>
            ) : (
              <ul className="mt-3 space-y-4">
                {data.incidents.map((i) => (
                  <li key={i.id} data-testid="incident">
                    <Card className="p-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold">{i.title}</h3>
                        <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs">
                          {s.impact[i.impact]}
                        </span>
                        <span className="text-xs text-muted">
                          {s.incidentStatus[i.status]} · {s.started}{' '}
                          {fmt.format(new Date(i.startedAt))} UTC
                          {i.resolvedAt
                            ? ` · ${s.resolved} ${fmt.format(new Date(i.resolvedAt))} UTC`
                            : ''}
                        </span>
                      </div>
                      <ol className="mt-3 space-y-2 border-s border-border ps-4">
                        {i.updates.map((u, n) => (
                          <li key={n} className="text-sm">
                            <span className="font-medium">{s.incidentStatus[u.status]}</span>{' '}
                            <span className="text-xs text-muted">
                              {fmt.format(new Date(u.at))} UTC
                            </span>
                            <p className="mt-0.5 whitespace-pre-wrap text-muted">{u.body}</p>
                          </li>
                        ))}
                      </ol>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
