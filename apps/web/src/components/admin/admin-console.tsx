'use client';

import type {
  ApprovalDto,
  KycReviewDto,
  ListingRequestDto,
  SystemHealthDto,
  TicketDto,
} from '@platform/shared';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/utils';

type A = Dictionary['admin'];
type Tab = keyof A['tabs'];
type Msg = { tone: 'error' | 'success'; text: string } | null;
const fmt = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

function errText(err: unknown, a: A): string {
  if (err instanceof ApiError) {
    if (err.code === 'MFA_REQUIRED') return a.mfaRequired;
    if (err.status === 403) return a.noAccess;
    return err.details?.[0]?.message ?? err.message;
  }
  return 'Request failed';
}

/** Loads an endpoint and renders an error instead of the content when it fails. */
function useResource<T>(
  path: string,
  a: A,
): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [v, setV] = useState(0);
  useEffect(() => {
    let active = true;
    api<T>(path)
      .then((d) => {
        if (!active) return;
        setData(d);
        setError(null);
      })
      .catch((err: unknown) => active && setError(errText(err, a)));
    return () => {
      active = false;
    };
  }, [path, v, a]);
  return { data, error, reload: useCallback(() => setV((x) => x + 1), []) };
}

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </Card>
  );
}

export function AdminConsole({ t }: { t: Dictionary }) {
  const a = t.admin;
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6" data-testid="admin-console">
      <h1 className="text-3xl font-semibold tracking-tight">{a.title}</h1>
      <p className="mt-1 text-sm text-muted">{a.intro}</p>
      <div role="tablist" className="mt-6 flex gap-1 overflow-x-auto border-b border-border">
        {(Object.keys(a.tabs) as Tab[]).map((key) => (
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
            {a.tabs[key]}
          </button>
        ))}
      </div>
      <div className="mt-6 space-y-6">
        {tab === 'overview' && <Overview a={a} />}
        {tab === 'approvals' && <Approvals a={a} />}
        {tab === 'kyc' && <Kyc a={a} />}
        {tab === 'support' && <Support a={a} />}
        {tab === 'users' && <Users a={a} />}
        {tab === 'audit' && <Audit a={a} />}
        {tab === 'listings' && <Listings a={a} />}
      </div>
    </div>
  );
}

function Overview({ a }: { a: A }) {
  const { data, error, reload } = useResource<SystemHealthDto>('/v1/admin/health', a);
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return null;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-4" data-testid="admin-overview">
        {(
          [
            [
              a.reconciliation,
              data.reconciliation
                ? `${data.reconciliation.status} · ${data.reconciliation.findings}`
                : '—',
            ],
            [a.tabs.approvals, String(data.queues.approvalsPending)],
            [a.tabs.kyc, String(data.queues.kycPending)],
            [a.tabs.support, String(data.queues.ticketsOpen)],
          ] as const
        ).map(([label, value]) => (
          <Card key={label} className="p-4">
            <CardDescription className="mt-0">{label}</CardDescription>
            <p className="mt-2 font-mono font-semibold">{value}</p>
          </Card>
        ))}
      </div>
      <Section
        title={a.markets}
        action={
          <Button size="sm" variant="outline" onClick={reload}>
            {a.refresh}
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-start text-muted">
                {['Market', 'Status', a.backlog, a.lag, a.index].map((h) => (
                  <th key={h} className="py-2 text-start font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.markets.map((m) => (
                <tr key={m.symbol} className="border-b border-border/60 last:border-0">
                  <td className="py-2 font-medium">{m.symbol}</td>
                  <td>
                    <Badge tone={m.status === 'ACTIVE' ? 'positive' : 'warning'}>{m.status}</Badge>
                  </td>
                  <td className="font-mono">{m.engineBacklog}</td>
                  <td className="font-mono">{m.settlementLag}</td>
                  <td>
                    {m.indexStale === null ? (
                      '—'
                    ) : m.indexStale ? (
                      <Badge tone="warning">{a.stale}</Badge>
                    ) : (
                      a.ok
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title={a.insurance}>
        {data.insuranceFunds.length === 0 ? (
          <p className="text-sm text-muted">{a.empty}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.insuranceFunds.map((f) => (
              <li key={f.asset} className="flex justify-between font-mono">
                <span>{f.asset}</span>
                <span>{f.balance}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">
          {a.liquidating}: {data.positionsLiquidating}
        </p>
      </Section>
    </>
  );
}

function Approvals({ a }: { a: A }) {
  const { data, error, reload } = useResource<{ requests: ApprovalDto[] }>(
    '/v1/admin/approvals?status=all&limit=50',
    a,
  );
  const [msg, setMsg] = useState<Msg>(null);
  const [action, setAction] = useState('market.resume');
  const [payload, setPayload] = useState('{"symbol": ""}');
  const [reason, setReason] = useState('');

  async function act(path: string) {
    setMsg(null);
    try {
      await api(path, { method: 'POST', body: {} });
      setMsg({ tone: 'success', text: a.done });
      reload();
    } catch (err) {
      setMsg({ tone: 'error', text: errText(err, a) });
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/v1/admin/approvals', {
        method: 'POST',
        body: { action, payload: JSON.parse(payload) as unknown, reason },
      });
      setReason('');
      setMsg({ tone: 'success', text: a.done });
      reload();
    } catch (err) {
      setMsg({
        tone: 'error',
        text: err instanceof SyntaxError ? 'Invalid JSON' : errText(err, a),
      });
    }
  }

  if (error) return <Alert tone="error">{error}</Alert>;
  const templates: Record<string, string> = {
    'market.resume': '{"symbol": ""}',
    'insurance_fund.seed': '{"asset": "", "amount": ""}',
    'ledger.reversal': '{"entryId": ""}',
    'user.reactivate': '{"userId": ""}',
    'role.grant': '{"userId": "", "role": "auditor"}',
  };
  return (
    <>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Section title={a.tabs.approvals}>
        {!data || data.requests.length === 0 ? (
          <p className="text-sm text-muted">{a.empty}</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.requests.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
                data-testid="approval-row"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    <code>{r.action}</code>{' '}
                    <span className="font-mono text-xs text-muted">
                      {JSON.stringify(r.payload)}
                    </span>
                  </p>
                  <p className="text-xs text-muted">
                    {a.requestedBy} {r.requestedBy} · {fmt.format(new Date(r.requestedAt))} ·{' '}
                    {a.reason}: {r.reason}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    tone={
                      r.status === 'approved'
                        ? 'positive'
                        : r.status === 'pending'
                          ? 'info'
                          : 'neutral'
                    }
                  >
                    {r.status}
                  </Badge>
                  {r.status === 'pending' && (
                    <>
                      <Button
                        size="sm"
                        onClick={() => void act(`/v1/admin/approvals/${r.id}/approve`)}
                      >
                        {a.approve}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void act(`/v1/admin/approvals/${r.id}/reject`)}
                      >
                        {a.reject}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void act(`/v1/admin/approvals/${r.id}/cancel`)}
                      >
                        {a.cancel}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={a.newRequest}>
        <form onSubmit={create} className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ap-action">{a.action}</Label>
            <select
              id="ap-action"
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setPayload(templates[e.target.value] ?? '{}');
              }}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
            >
              {Object.keys(templates).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="ap-reason">{a.reason}</Label>
            <Input id="ap-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="ap-payload">{a.payload}</Label>
            <Input
              id="ap-payload"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              className="font-mono"
            />
          </div>
          <div>
            <Button type="submit" disabled={reason.trim().length < 5}>
              {a.submit}
            </Button>
          </div>
        </form>
      </Section>
    </>
  );
}

function Kyc({ a }: { a: A }) {
  const { data, error, reload } = useResource<{ cases: KycReviewDto[] }>('/v1/admin/kyc', a);
  const [open, setOpen] = useState<KycReviewDto | null>(null);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<Msg>(null);

  async function decide(decision: 'approve' | 'reject' | 'needs_info') {
    if (!open) return;
    setMsg(null);
    try {
      await api(`/v1/admin/kyc/${open.id}/decision`, { method: 'POST', body: { decision, note } });
      setOpen(null);
      setNote('');
      setMsg({ tone: 'success', text: a.done });
      reload();
    } catch (err) {
      setMsg({ tone: 'error', text: errText(err, a) });
    }
  }

  if (error) return <Alert tone="error">{error}</Alert>;
  return (
    <>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {open ? (
        <Section title={`${a.review}: ${open.email}`}>
          <p className="text-xs text-muted">{a.profile}</p>
          <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
            {Object.entries(open.profile ?? {}).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted">
            {a.screening}: restricted country {String(open.screening.restrictedCountry)} · sanctions{' '}
            {open.screening.sanctions} ({open.screening.sanctionsProvider})
          </p>
          <div className="mt-3">
            <Label htmlFor="kyc-note">{a.decisionNote}</Label>
            <Input id="kyc-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              disabled={note.trim().length < 3}
              onClick={() => void decide('approve')}
            >
              {a.approve}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={note.trim().length < 3}
              onClick={() => void decide('needs_info')}
            >
              {a.needsInfo}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={note.trim().length < 3}
              onClick={() => void decide('reject')}
            >
              {a.reject}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setOpen(null)}>
              {a.cancel}
            </Button>
          </div>
        </Section>
      ) : (
        <Section title={a.tabs.kyc}>
          {!data || data.cases.length === 0 ? (
            <p className="text-sm text-muted">{a.empty}</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.cases.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-3">
                  <span className="text-sm">
                    {c.email} · {c.countryCode} · {fmt.format(new Date(c.submittedAt))}
                    {c.screening.restrictedCountry && (
                      <Badge tone="negative" className="ms-2">
                        restricted
                      </Badge>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void api<KycReviewDto>(`/v1/admin/kyc/${c.id}`)
                        .then(setOpen)
                        .catch((err: unknown) => setMsg({ tone: 'error', text: errText(err, a) }))
                    }
                  >
                    {a.review}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </>
  );
}

function Support({ a }: { a: A }) {
  const { data, error, reload } = useResource<{ tickets: TicketDto[] }>('/v1/admin/tickets', a);
  const [open, setOpen] = useState<TicketDto | null>(null);
  const [reply, setReply] = useState('');
  const [msg, setMsg] = useState<Msg>(null);

  async function post(path: string, body: object) {
    setMsg(null);
    try {
      setOpen(await api<TicketDto>(path, { method: 'POST', body }));
      setReply('');
      reload();
    } catch (err) {
      setMsg({ tone: 'error', text: errText(err, a) });
    }
  }

  if (error) return <Alert tone="error">{error}</Alert>;
  return (
    <>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {open ? (
        <Section
          title={`${open.subject} · ${open.userEmail ?? ''}`}
          action={<Badge>{open.status}</Badge>}
        >
          <ol className="space-y-2">
            {(open.messages ?? []).map((m) => (
              <li
                key={m.id}
                className={cn(
                  'rounded-md border border-border p-3 text-sm',
                  m.fromStaff && 'bg-surface-raised',
                )}
              >
                <p className="text-xs text-muted">
                  {m.fromStaff ? 'Staff' : 'User'} · {fmt.format(new Date(m.createdAt))}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
              </li>
            ))}
          </ol>
          {open.status !== 'closed' && (
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void post(`/v1/admin/tickets/${open.id}/messages`, { body: reply });
              }}
            >
              <Input
                aria-label={a.reply}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
              />
              <Button type="submit" disabled={!reply.trim()}>
                {a.reply}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void post(`/v1/admin/tickets/${open.id}/close`, {})}
              >
                {a.close}
              </Button>
            </form>
          )}
          <Button className="mt-3" size="sm" variant="outline" onClick={() => setOpen(null)}>
            ←
          </Button>
        </Section>
      ) : (
        <Section title={a.tabs.support}>
          {!data || data.tickets.length === 0 ? (
            <p className="text-sm text-muted">{a.empty}</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.tickets.map((tk) => (
                <li key={tk.id}>
                  <button
                    type="button"
                    className="flex w-full justify-between gap-2 py-3 text-start text-sm"
                    onClick={() =>
                      void api<TicketDto>(`/v1/admin/tickets/${tk.id}`)
                        .then(setOpen)
                        .catch(() => undefined)
                    }
                  >
                    <span>
                      {tk.subject} <span className="text-muted">· {tk.userEmail}</span>
                    </span>
                    <Badge>{tk.status}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </>
  );
}

interface AdminUser {
  id: string;
  email: string;
  status: string;
  mfaEnabled: boolean;
  roles: string[];
  createdAt: string;
}

function Users({ a }: { a: A }) {
  const { data, error, reload } = useResource<{ users: AdminUser[] }>(
    '/v1/admin/users?limit=50',
    a,
  );
  const [msg, setMsg] = useState<Msg>(null);
  const [reason, setReason] = useState('');

  async function run(path: string, body: object) {
    setMsg(null);
    try {
      await api(path, { method: 'POST', body });
      setMsg({ tone: 'success', text: a.done });
      reload();
    } catch (err) {
      setMsg({ tone: 'error', text: errText(err, a) });
    }
  }

  if (error) return <Alert tone="error">{error}</Alert>;
  return (
    <>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Section title={a.tabs.users}>
        <div className="mb-3 max-w-md">
          <Label htmlFor="user-reason">{a.reason}</Label>
          <Input id="user-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <tbody>
              {(data?.users ?? []).map((u) => (
                <tr key={u.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2">{u.email}</td>
                  <td>
                    <Badge tone={u.status === 'ACTIVE' ? 'positive' : 'warning'}>{u.status}</Badge>
                  </td>
                  <td className="text-xs text-muted">{u.roles.join(', ')}</td>
                  <td className="text-xs text-muted">{u.mfaEnabled ? 'MFA' : '—'}</td>
                  <td className="text-end">
                    {u.status === 'SUSPENDED' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={reason.trim().length < 5}
                        onClick={() =>
                          void run('/v1/admin/approvals', {
                            action: 'user.reactivate',
                            payload: { userId: u.id },
                            reason,
                          })
                        }
                      >
                        {a.requestReactivation}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={reason.trim().length < 5}
                        onClick={() => void run(`/v1/admin/users/${u.id}/suspend`, { reason })}
                      >
                        {a.suspend}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

interface AuditEntry {
  id: string;
  action: string;
  outcome: string;
  actorType: string;
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  occurredAt: string;
}

function Audit({ a }: { a: A }) {
  const { data, error } = useResource<{ entries: AuditEntry[] }>(
    '/v1/admin/audit-logs?limit=100',
    a,
  );
  if (error) return <Alert tone="error">{error}</Alert>;
  return (
    <Section title={a.tabs.audit}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-xs">
          <tbody>
            {(data?.entries ?? []).map((e) => (
              <tr key={e.id} className="border-b border-border/60 last:border-0">
                <td className="py-1.5 font-mono text-muted">
                  {fmt.format(new Date(e.occurredAt))}
                </td>
                <td className="font-mono">{e.action}</td>
                <td>{e.outcome}</td>
                <td className="text-muted">{e.actorType}</td>
                <td className="font-mono text-muted">
                  {e.targetType ? `${e.targetType}:${(e.targetId ?? '').slice(0, 12)}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** Listing requests (ADR-0026): decide against the published criteria; decisions are public. */
function Listings({ a }: { a: A }) {
  const { data, error, reload } = useResource<{ requests: ListingRequestDto[] }>('/v1/listings', a);
  const [open, setOpen] = useState<string | null>(null);
  const [status, setStatus] = useState<'review' | 'listed' | 'rejected'>('review');
  const [note, setNote] = useState('');
  const [market, setMarket] = useState('');
  const [msg, setMsg] = useState<Msg>(null);

  async function decide(e: FormEvent, id: string) {
    e.preventDefault();
    setMsg(null);
    try {
      await api(`/v1/admin/listings/${id}/decision`, {
        method: 'POST',
        body: {
          status,
          ...(note ? { note } : {}),
          ...(status === 'listed' ? { market } : {}),
        },
      });
      setMsg({ tone: 'success', text: a.decided });
      setOpen(null);
      setNote('');
      setMarket('');
      reload();
    } catch (err) {
      setMsg({ tone: 'error', text: errText(err, a) });
    }
  }

  if (error) return <Alert tone="error">{error}</Alert>;
  const live = (data?.requests ?? []).filter((r) => r.status === 'open' || r.status === 'review');
  return (
    <Section title={a.listingsTitle}>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {live.length === 0 && <p className="text-sm text-muted">{a.listingsEmpty}</p>}
      <ul className="space-y-3">
        {live.map((r) => (
          <li key={r.id} className="rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                {r.baseSymbol}/{r.quoteAsset} · {r.kind} · {r.eligibleVotes}/{r.totalVotes}
              </span>
              <Badge>{r.status}</Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setOpen(open === r.id ? null : r.id)}
              >
                {a.decision}
              </Button>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-muted">{r.rationale}</p>
            {open === r.id && (
              <form className="mt-3 space-y-2" onSubmit={(e) => void decide(e, r.id)}>
                <select
                  aria-label={a.decision}
                  className="h-9 rounded-md border border-border bg-background px-2"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as typeof status)}
                >
                  {r.status === 'open' && <option value="review">review</option>}
                  <option value="listed">listed</option>
                  <option value="rejected">rejected</option>
                </select>
                <div>
                  <Label htmlFor={`note-${r.id}`}>{a.listingNote}</Label>
                  <Input
                    id={`note-${r.id}`}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
                {status === 'listed' && (
                  <div>
                    <Label htmlFor={`mkt-${r.id}`}>{a.decisionMarket}</Label>
                    <Input
                      id={`mkt-${r.id}`}
                      value={market}
                      onChange={(e) => setMarket(e.target.value.trim())}
                    />
                  </div>
                )}
                <Button type="submit" size="sm">
                  {a.decide}
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
