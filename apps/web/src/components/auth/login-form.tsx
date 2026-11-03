'use client';

import type { LoginResultDto } from '@platform/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { api } from '@/lib/api';
import { AuthShell, errorMessage, type AuthText } from './shared';

export function LoginForm({ t }: { t: AuthText }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = challengeId
        ? await api<LoginResultDto>('/v1/auth/login/mfa', {
            method: 'POST',
            body: { challengeId, code },
          })
        : await api<LoginResultDto>('/v1/auth/login', {
            method: 'POST',
            body: { email, password },
          });
      if (result.status === 'mfa_required') {
        setChallengeId(result.challengeId);
        setPassword('');
      } else {
        router.replace('/dashboard');
        router.refresh();
      }
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={challengeId ? t.mfaTitle : t.loginTitle}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert tone="error">{error}</Alert>}
        {challengeId ? (
          <div>
            <p className="mb-4 text-sm text-muted">{t.mfaPrompt}</p>
            <Label htmlFor="code">{t.mfaCode}</Label>
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              dir="ltr"
            />
          </div>
        ) : (
          <>
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
            <div>
              <div className="flex items-baseline justify-between">
                <Label htmlFor="password">{t.password}</Label>
                <Link href={'/forgot-password'} className="text-xs text-primary hover:underline">
                  {t.forgot}
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                dir="ltr"
              />
            </div>
          </>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {challengeId ? t.mfaSubmit : t.loginSubmit}
        </Button>
        {!challengeId && (
          <p className="text-center text-sm text-muted">
            {t.noAccount}{' '}
            <Link href={'/register'} className="text-primary hover:underline">
              {t.registerSubmit}
            </Link>
          </p>
        )}
      </form>
    </AuthShell>
  );
}
