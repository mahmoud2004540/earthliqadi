'use client';

import { passwordSchema } from '@platform/shared';
import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { api, tokenFromHash } from '@/lib/api';
import { AuthShell, FieldError, errorMessage, type AuthText } from './shared';

let capturedToken: string | null = null;

/** Reads the token from the URL fragment once, then strips it from the address bar/history. */
function readFragmentToken(): string | null {
  const fromHash = tokenFromHash();
  if (fromHash) {
    capturedToken = fromHash;
    window.history.replaceState(null, '', window.location.pathname);
  }
  return capturedToken;
}

const noSubscription = () => () => undefined;

/** `undefined` during server render / hydration, then the token or `null` if absent. */
function useFragmentToken(): string | null | undefined {
  return useSyncExternalStore(noSubscription, readFragmentToken, () => undefined);
}

export function VerifyEmail({ t }: { t: AuthText }) {
  const token = useFragmentToken();
  const [result, setResult] = useState<{ status: 'pending' | 'done' | 'error'; message?: string }>({
    status: 'pending',
  });
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api('/v1/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => setResult({ status: 'done' }))
      .catch((err: unknown) => setResult({ status: 'error', message: errorMessage(t, err) }));
  }, [token, t]);

  const state = token === null ? { status: 'error' as const, message: t.missingToken } : result;

  return (
    <AuthShell title={t.verifyTitle}>
      {state.status === 'pending' && <p className="text-sm text-muted">{t.verifying}</p>}
      {state.status === 'error' && <Alert tone="error">{state.message}</Alert>}
      {state.status === 'done' && <Alert tone="success">{t.verifyDone}</Alert>}
      {state.status !== 'pending' && (
        <Button asChild className="mt-6 w-full">
          <Link href={'/login'}>{t.loginSubmit}</Link>
        </Button>
      )}
    </AuthShell>
  );
}

export function ForgotPasswordForm({ t }: { t: AuthText }) {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/v1/auth/password/forgot', { method: 'POST', body: { email } });
      setDone(true);
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t.forgotTitle}>
      {done ? (
        <Alert tone="success">{t.forgotDone}</Alert>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <div>
            <Label htmlFor="email">{t.email}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              dir="ltr"
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {t.forgotSubmit}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPasswordForm({ t }: { t: AuthText }) {
  const token = useFragmentToken();
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message);
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    setError(null);
    try {
      await api('/v1/auth/password/reset', {
        method: 'POST',
        body: { token, newPassword: password },
      });
      setDone(true);
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  if (token === null) {
    return (
      <AuthShell title={t.resetTitle}>
        <Alert tone="error">{t.missingToken}</Alert>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={t.resetTitle}>
      {done ? (
        <>
          <Alert tone="success">{t.resetDone}</Alert>
          <Button asChild className="mt-6 w-full">
            <Link href={'/login'}>{t.loginSubmit}</Link>
          </Button>
        </>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <div>
            <Label htmlFor="password">{t.newPassword}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby="pw-hint pw-error"
              dir="ltr"
            />
            <p id="pw-hint" className="mt-1.5 text-xs text-muted">
              {t.passwordHint}
            </p>
            <FieldError id="pw-error" message={fieldError} />
          </div>
          <Button type="submit" className="w-full" disabled={busy || !token}>
            {t.resetSubmit}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
