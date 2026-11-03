import { NextResponse, type NextRequest } from 'next/server';
import { isLocale, negotiateLocale } from './i18n';

const SESSION_COOKIES = ['__Host-session', 'session'];

/**
 * 1. Redirects locale-less paths to the negotiated locale.
 * 2. Fast-path redirect of signed-out visitors away from the dashboard. This is
 *    a UX convenience only — the API enforces authentication on every request.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const [, first, second] = pathname.split('/');

  if (!isLocale(first)) {
    const locale = negotiateLocale(request.headers.get('accept-language'));
    const url = request.nextUrl.clone();
    url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;
    return NextResponse.redirect(url);
  }

  if (second === 'dashboard' && !SESSION_COOKIES.some((name) => request.cookies.has(name))) {
    const url = request.nextUrl.clone();
    url.pathname = `/${first}/login`;
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Skip API proxy, Next internals and static files.
  matcher: ['/((?!api|_next|.*\\..*).*)'],
};
