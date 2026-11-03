'use client';

import type { AnnouncementDto, KycStatusDto, NotificationDto, TicketDto } from '@platform/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';

type Msg = { tone: 'error' | 'success'; text: string } | null;

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.details?.[0]?.message ?? err.message;
  return 'Something went wrong. Please try again.';
}

const fmt = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

// ------------------------------------------------------------- verification

export function VerificationPanel({ t }: { t: Dictionary }) {
  const v = t.dashboard.verification;
  const [status, setStatus] = useState<KycStatusDto | null>(null);
  const [form, setForm] = useState({
    legalName: '',
    dateOfBirth: '',
    countryCode: '',
    addressLine: '',
    city: '',
    postalCode: '',
  });
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<KycStatusDto>('/v1/me/verification')
      .then(setStatus)
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      setStatus(await api<KycStatusDto>('/v1/me/verification', { method: 'POST', body: form }));
      setMsg({ tone: 'success', text: v.submitted });
    } catch (err) {
      setMsg({ tone: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  const c = status?.case ?? null;
  const canSubmit =
    status !== null &&
    status.level === 0 &&
    (!c || c.status === 'rejected' || c.status === 'needs_info');
  const fields: [keyof typeof form, string, string?][] = [
    ['legalName', v.legalName, 'name'],
    ['dateOfBirth', v.dateOfBirth, 'bday'],
    ['countryCode', v.countryCode, 'country'],
    ['addressLine', v.addressLine, 'street-address'],
    ['city', v.city, 'address-level2'],
    ['postalCode', v.postalCode, 'postal-code'],
  ];

  return (
    <div className="space-y-6" data-testid="verification-panel">
      <Card className="p-5">
        <CardTitle>{v.title}</CardTitle>
        <CardDescription>{v.intro}</CardDescription>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">{v.level}</dt>
            <dd className="mt-1 font-semibold" data-testid="kyc-level">
              {status ? v.levels[status.level] : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{v.status}</dt>
            <dd className="mt-1">
              {c ? (
                <Badge
                  tone={
                    c.status === 'approved'
                      ? 'positive'
                      : c.status === 'pending'
                        ? 'info'
                        : 'warning'
                  }
                >
                  {v.statuses[c.status]}
                </Badge>
              ) : (
                '—'
              )}
              {c?.note && <p className="mt-1 text-sm text-muted">{c.note}</p>}
            </dd>
          </div>
        </dl>
      </Card>
      {canSubmit && (
        <Card className="p-5">
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
            {fields.map(([key, label, auto]) => (
              <div key={key} className={key === 'addressLine' ? 'sm:col-span-2' : undefined}>
                <Label htmlFor={`kyc-${key}`}>{label}</Label>
                <Input
                  id={`kyc-${key}`}
                  autoComplete={auto}
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              </div>
            ))}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={busy}>
                {v.submit}
              </Button>
            </div>
          </form>
        </Card>
      )}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <p className="text-xs text-muted">{v.noProvider}</p>
    </div>
  );
}

// ------------------------------------------------------------------ support

export function SupportPanel({ t }: { t: Dictionary }) {
  const s = t.dashboard.support;
  const [tickets, setTickets] = useState<TicketDto[]>([]);
  const [open, setOpen] = useState<TicketDto | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState('');
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(() => {
    api<{ tickets: TicketDto[] }>('/v1/me/tickets')
      .then((r) => setTickets(r.tickets))
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const ticket = await api<TicketDto>('/v1/me/tickets', {
        method: 'POST',
        body: { subject, body },
      });
      setSubject('');
      setBody('');
      setOpen(ticket);
      load();
    } catch (err) {
      setMsg({ tone: 'error', text: errorText(err) });
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!open) return;
    try {
      setOpen(
        await api<TicketDto>(`/v1/me/tickets/${open.id}/messages`, {
          method: 'POST',
          body: { body: reply },
        }),
      );
      setReply('');
      load();
    } catch (err) {
      setMsg({ tone: 'error', text: errorText(err) });
    }
  }

  if (open) {
    return (
      <div className="space-y-4" data-testid="ticket-view">
        <Button variant="outline" size="sm" onClick={() => setOpen(null)}>
          ← {s.back}
        </Button>
        <Card className="p-5">
          <div className="flex items-center justify-between gap-2">
            <CardTitle>{open.subject}</CardTitle>
            <Badge>{s.statuses[open.status]}</Badge>
          </div>
          <ol className="mt-4 space-y-3">
            {(open.messages ?? []).map((m) => (
              <li
                key={m.id}
                className="rounded-md border border-border p-3"
                data-testid="ticket-message"
              >
                <p className="text-xs text-muted">
                  {m.fromStaff ? s.staff : s.you} · {fmt.format(new Date(m.createdAt))}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{m.body}</p>
              </li>
            ))}
          </ol>
          {open.status !== 'closed' && (
            <form onSubmit={send} className="mt-4 flex gap-2">
              <Input
                aria-label={s.message}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
              />
              <Button type="submit" disabled={!reply.trim()}>
                {s.send}
              </Button>
            </form>
          )}
        </Card>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="support-panel">
      <Card className="p-5">
        <CardTitle>{s.newTicket}</CardTitle>
        <form onSubmit={create} className="mt-4 space-y-3">
          <div>
            <Label htmlFor="ticket-subject">{s.subject}</Label>
            <Input
              id="ticket-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="ticket-body">{s.message}</Label>
            <textarea
              id="ticket-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <Button type="submit" disabled={subject.trim().length < 3 || !body.trim()}>
            {s.create}
          </Button>
        </form>
      </Card>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Card className="p-5">
        <CardTitle>{s.title}</CardTitle>
        {tickets.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{s.empty}</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {tickets.map((tk) => (
              <li key={tk.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 py-3 text-start"
                  onClick={() =>
                    void api<TicketDto>(`/v1/me/tickets/${tk.id}`)
                      .then(setOpen)
                      .catch(() => undefined)
                  }
                >
                  <span className="text-sm font-medium">{tk.subject}</span>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    {fmt.format(new Date(tk.updatedAt))}
                    <Badge>{s.statuses[tk.status]}</Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// -------------------------------------------------------------------- inbox

export function InboxPanel({ t }: { t: Dictionary }) {
  const ib = t.dashboard.inbox;
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [unread, setUnread] = useState(0);
  const [announcements, setAnnouncements] = useState<AnnouncementDto[]>([]);

  const load = useCallback(() => {
    api<{ items: NotificationDto[]; unread: number }>('/v1/me/notifications')
      .then((r) => {
        setItems(r.items);
        setUnread(r.unread);
      })
      .catch(() => undefined);
    api<{ announcements: AnnouncementDto[] }>('/v1/announcements')
      .then((r) => setAnnouncements(r.announcements))
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  return (
    <div className="grid gap-6 lg:grid-cols-2" data-testid="inbox-panel">
      <Card className="p-5">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>
            {ib.notifications}{' '}
            {unread > 0 && (
              <Badge tone="info">
                {unread} {ib.unread}
              </Badge>
            )}
          </CardTitle>
          {unread > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void api('/v1/me/notifications/read', { method: 'POST', body: {} }).then(load)
              }
            >
              {ib.markAllRead}
            </Button>
          )}
        </div>
        {items.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{ib.empty}</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {items.map((n) => (
              <li
                key={n.id}
                className="rounded-md border border-border p-3"
                data-testid="notification"
              >
                <p className="flex items-center gap-2 text-sm font-medium">
                  {!n.read && <span aria-hidden className="size-2 rounded-full bg-primary" />}
                  {n.title}
                </p>
                <p className="mt-1 text-sm text-muted">{n.body}</p>
                <p className="mt-1 text-xs text-muted">{fmt.format(new Date(n.createdAt))}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="p-5">
        <CardTitle>{ib.announcements}</CardTitle>
        {announcements.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{ib.empty}</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {announcements.map((a) => (
              <li key={a.id} className="rounded-md border border-border p-3">
                <p className="text-sm font-medium">{a.title}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{a.body}</p>
                <p className="mt-1 text-xs text-muted">{fmt.format(new Date(a.publishedAt))}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
