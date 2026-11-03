'use client';

import type { ReactNode } from 'react';
import type { Dictionary } from '@/i18n';
import { ApiError } from '@/lib/api';

export type AuthText = Dictionary['auth'];

export function errorMessage(t: AuthText, err: unknown): string {
  if (err instanceof ApiError && err.code in t.errors) {
    return t.errors[err.code as keyof AuthText['errors']];
  }
  return t.errors.generic;
}

export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-16 sm:px-6">
      <div className="rounded-lg border border-border bg-surface p-6 sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 text-xs text-negative">
      {message}
    </p>
  );
}
