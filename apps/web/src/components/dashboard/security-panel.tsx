'use client';

import { changePasswordSchema, type CurrentUserDto, type SessionDto } from '@platform/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage } from '@/components/auth/shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { api } from '@/lib/api';

type Props = { user: CurrentUserDto; t: Dictionary; onChange: () => void };

export function SecurityPanel({ user, t, onChange }: Props) {
  return (
    <div className="mt-8 space-y-6">
      <SessionsCard t={t} />
      <MfaCard user={user} t={t} onChange={onChange} />
      <PasswordCard t={t} />
    </div>
  );
}

function SessionsCard({ t }: { t: Dictionary }) {
  const d = t.dashboard;
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fmt = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    api<{ sessions: SessionDto[] }>('/v1/me/sessions')
      .then((res) => {
        if (active) setSessions(res.sessions);
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(t.auth, err));
      });
    return () => {
      active = false;
    };
  }, [t.auth, version]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      setVersion((v) => v + 1);
    } catch (err) {
      setError(errorMessage(t.auth, err));
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle>{d.sessionsTitle}</CardTitle>
          <CardDescription>{d.sessionsIntro}</CardDescription>
        </div>
        <Button
          variant="danger"
          size="sm"
          onClick={() => run(() => api('/v1/me/sessions/revoke-others', { method: 'POST' }))}
        >
          {d.revokeOthers}
        </Button>
      </div>
      {error && (
        <Alert tone="error" className="mt-4">
          {error}
        </Alert>
      )}
      <ul className="mt-4 divide-y divide-border">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" dir="ltr">
                {s.userAgent ?? 'Unknown device'}
              </p>
              <p className="text-xs text-muted">
                <span dir="ltr">{s.ipAddress ?? '—'}</span> · {d.lastActive}{' '}
                {fmt.format(new Date(s.lastSeenAt))}
              </p>
            </div>
            {s.current ? (
              <Badge tone="info">{d.thisDevice}</Badge>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => run(() => api(`/v1/me/sessions/${s.id}`, { method: 'DELETE' }))}
              >
                {d.revoke}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function MfaCard({
  user,
  t,
  onChange,
}: {
  user: CurrentUserDto;
  t: Dictionary;
  onChange: () => void;
}) {
  const d = t.dashboard;
  const [step, setStep] = useState<'idle' | 'password' | 'code' | 'disable'>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setStep('idle');
    setPassword('');
    setCode('');
    setSecret(null);
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === 'password') {
        const res = await api<{ secret: string }>('/v1/me/mfa/totp/setup', {
          method: 'POST',
          body: { password },
        });
        setSecret(res.secret);
        setPassword('');
        setStep('code');
      } else if (step === 'code') {
        await api('/v1/me/mfa/totp/enable', { method: 'POST', body: { code } });
        reset();
        onChange();
      } else if (step === 'disable') {
        await api('/v1/me/mfa/totp/disable', { method: 'POST', body: { password, code } });
        reset();
        onChange();
      }
    } catch (err) {
      setError(errorMessage(t.auth, err));
    } finally {
      setBusy(false);
    }
  }

  const codeInput = (
    <div>
      <Label htmlFor="totp">{t.auth.mfaCode}</Label>
      <Input
        id="totp"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        dir="ltr"
      />
    </div>
  );
  const passwordInput = (
    <div>
      <Label htmlFor="mfa-password">{d.mfaConfirmPassword}</Label>
      <Input
        id="mfa-password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        dir="ltr"
      />
    </div>
  );

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle>{d.mfaTitle}</CardTitle>
          <CardDescription>{user.mfaEnabled ? d.mfaEnabledNotice : d.mfaIntro}</CardDescription>
        </div>
        {step === 'idle' &&
          (user.mfaEnabled ? (
            <Button variant="danger" size="sm" onClick={() => setStep('disable')}>
              {d.mfaDisable}
            </Button>
          ) : (
            <Button size="sm" onClick={() => setStep('password')}>
              {d.mfaStart}
            </Button>
          ))}
      </div>
      {step !== 'idle' && (
        <form onSubmit={submit} className="mt-6 max-w-sm space-y-4">
          {error && <Alert tone="error">{error}</Alert>}
          {step === 'password' && passwordInput}
          {step === 'code' && secret && (
            <>
              <p className="text-sm text-muted">{d.mfaScan}</p>
              <div>
                <p className="text-xs text-muted">{d.mfaSecret}</p>
                <code
                  className="mt-1 block break-all rounded-md bg-background p-3 font-mono text-sm"
                  dir="ltr"
                >
                  {secret.replace(/(.{4})/g, '$1 ').trim()}
                </code>
              </div>
              {codeInput}
            </>
          )}
          {step === 'disable' && (
            <>
              {passwordInput}
              {codeInput}
            </>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={busy}
              variant={step === 'disable' ? 'danger' : 'primary'}
            >
              {step === 'disable' ? d.mfaDisable : step === 'code' ? d.mfaEnable : t.auth.mfaSubmit}
            </Button>
            <Button type="button" variant="ghost" onClick={reset}>
              {d.cancel}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function PasswordCard({ t }: { t: Dictionary }) {
  const d = t.dashboard;
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = changePasswordSchema.safeParse({ currentPassword, newPassword });
    if (!parsed.success) {
      setMessage({
        tone: 'error',
        text: parsed.error.issues[0]?.message ?? t.auth.errors.VALIDATION_FAILED,
      });
      return;
    }
    setBusy(true);
    try {
      await api('/v1/me/password', { method: 'POST', body: parsed.data });
      setMessage({ tone: 'success', text: d.passwordDone });
      setCurrent('');
      setNew('');
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(t.auth, err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle>{d.passwordTitle}</CardTitle>
      <CardDescription>{d.passwordIntro}</CardDescription>
      <form onSubmit={submit} className="mt-6 max-w-sm space-y-4" noValidate>
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        <div>
          <Label htmlFor="current-password">{t.auth.currentPassword}</Label>
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrent(e.target.value)}
            dir="ltr"
          />
        </div>
        <div>
          <Label htmlFor="new-password">{t.auth.newPassword}</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
            dir="ltr"
          />
          <p className="mt-1.5 text-xs text-muted">{t.auth.passwordHint}</p>
        </div>
        <Button type="submit" disabled={busy}>
          {d.passwordSubmit}
        </Button>
      </form>
    </Card>
  );
}
