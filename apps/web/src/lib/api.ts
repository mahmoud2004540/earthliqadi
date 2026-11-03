'use client';

import type { ApiErrorBody, ApiErrorCode } from '@platform/shared';

/**
 * Browser API client. All calls go through the same-origin `/api` rewrite so
 * the session cookie stays first-party. State-changing requests carry the
 * CSRF token; on a CSRF failure the token is refreshed once and retried.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode | 'NETWORK_ERROR',
    message: string,
    public readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

async function fetchCsrf(): Promise<string> {
  const res = await fetch('/api/v1/auth/csrf', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new ApiError(res.status, 'SERVICE_UNAVAILABLE', 'Unable to reach the server');
  csrfToken = ((await res.json()) as { csrfToken: string }).csrfToken;
  return csrfToken;
}

export async function api<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {},
  retried = false,
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['X-CSRF-Token'] = csrfToken ?? (await fetchCsrf());
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Network error');
  }

  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (json as ApiErrorBody | null)?.error;
    if (err?.code === 'CSRF_INVALID' && !retried) {
      csrfToken = null;
      return api<T>(path, options, true);
    }
    throw new ApiError(
      res.status,
      err?.code ?? 'INTERNAL_ERROR',
      err?.message ?? 'Request failed',
      err?.details,
    );
  }
  return json as T;
}

/** Reads a token from the URL fragment (`#token=...`); fragments are never sent to servers or in Referer. */
export function tokenFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get('token');
}
