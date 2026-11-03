import type { CookieOptions, Response } from 'express';
import type { AppConfig } from '../config/app-config';

/**
 * `__Host-` prefixed cookies are only accepted by browsers when Secure, Path=/
 * and no Domain — this pins them to the exact origin. Insecure local
 * development (http://localhost) cannot use the prefix.
 */
export function cookieNames(config: AppConfig): { session: string; csrf: string } {
  return config.SESSION_COOKIE_SECURE
    ? { session: '__Host-session', csrf: '__Host-csrf' }
    : { session: 'session', csrf: 'csrf' };
}

function baseOptions(config: AppConfig): CookieOptions {
  return { httpOnly: true, secure: config.SESSION_COOKIE_SECURE, path: '/' };
}

export function setSessionCookie(res: Response, config: AppConfig, token: string): void {
  res.cookie(cookieNames(config).session, token, {
    ...baseOptions(config),
    sameSite: 'lax',
    maxAge: config.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600 * 1000,
  });
}

export function clearSessionCookie(res: Response, config: AppConfig): void {
  res.clearCookie(cookieNames(config).session, { ...baseOptions(config), sameSite: 'lax' });
}

export function setCsrfCookie(res: Response, config: AppConfig, token: string): void {
  res.cookie(cookieNames(config).csrf, token, { ...baseOptions(config), sameSite: 'strict' });
}
