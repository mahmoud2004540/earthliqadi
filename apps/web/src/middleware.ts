import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIES = ['__Host-session', 'session'];
/** Former locale prefixes; kept as permanent redirects so old links (including emails) keep working. */
const LEGACY_PREFIX = /^\/(en|ar)(?=\/|$)/;

/**
 * 1. Redirects legacy /en/... and /ar/... URLs to the English-only paths.
 * 2. Fast-path redirect of signed-out visitors away from the dashboard. This is
 *    a UX convenience only; the API enforces authentication on every request.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (LEGACY_PREFIX.test(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = pathname.replace(LEGACY_PREFIX, '') || '/';
    return NextResponse.redirect(url, 308);
  }

  if (
    pathname.split('/')[1] === 'dashboard' &&
    !SESSION_COOKIES.some((name) => request.cookies.has(name))
  ) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Skip API proxy, Next internals and static files.
  matcher: ['/((?!api|_next|.*\\..*).*)'],
};
