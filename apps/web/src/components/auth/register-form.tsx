'use client';

import { registerSchema } from '@platform/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { api } from '@/lib/api';
import { AuthShell, FieldError, errorMessage, type AuthText } from './shared';

export function RegisterForm({ t, riskLabel }: { t: AuthText; riskLabel: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    // Same zod schema the API uses: instant feedback, no drift between client and server rules.
    const parsed = registerSchema.safeParse({ email, password, acceptTerms });
    if (!parsed.success) {
      setFieldErrors(
        Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])),
      );
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      await api('/v1/auth/register', { method: 'POST', body: parsed.data });
      setDone(true);
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthShell title={t.registerTitle}>
        <Alert tone="success">{t.registerDone}</Alert>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t.registerTitle}>
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
            aria-invalid={!!fieldErrors.email}
            aria-describedby="email-error"
            dir="ltr"
          />
          <FieldError id="email-error" message={fieldErrors.email} />
        </div>
        <div>
          <Label htmlFor="password">{t.password}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!fieldErrors.password}
            aria-describedby="password-hint password-error"
            dir="ltr"
          />
          <p id="password-hint" className="mt-1.5 text-xs text-muted">
            {t.passwordHint}
          </p>
          <FieldError id="password-error" message={fieldErrors.password} />
        </div>
        <div className="flex items-start gap-3">
          <input
            id="terms"
            type="checkbox"
            checked={acceptTerms}
            onChange={(e) => setAcceptTerms(e.target.checked)}
            className="mt-1 size-4 accent-primary"
          />
          <label htmlFor="terms" className="text-sm text-muted">
            {t.acceptTerms}{' '}
            <Link href={'/risk'} className="text-primary hover:underline">
              {riskLabel}
            </Link>
          </label>
        </div>
        <FieldError id="terms-error" message={fieldErrors.acceptTerms} />
        <Button type="submit" className="w-full" disabled={busy}>
          {t.registerSubmit}
        </Button>
        <p className="text-center text-sm text-muted">
          {t.haveAccount}{' '}
          <Link href={'/login'} className="text-primary hover:underline">
            {t.loginSubmit}
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
