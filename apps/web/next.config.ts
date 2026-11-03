import { parseEnv, webEnvSchema } from '@platform/config';
import type { NextConfig } from 'next';
import path from 'node:path';

const env = parseEnv(webEnvSchema);
const isDev = env.NODE_ENV !== 'production';

/**
 * Content Security Policy. Next.js App Router injects inline bootstrap
 * scripts, so 'unsafe-inline' is required for scripts until nonce-based CSP is
 * adopted (tracked in docs/security/threat-model.md). Everything else is
 * locked to same-origin; the API is reached through the /api rewrite.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? ' ws:' : ''}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // no-referrer: auth links carry tokens in the URL fragment, which is never sent,
  // but we still never leak page URLs to third parties.
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(isDev
    ? []
    : [
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
      ]),
];

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  poweredByHeader: false,
  reactStrictMode: true,
  env: { NEXT_PUBLIC_BRAND_NAME: env.NEXT_PUBLIC_BRAND_NAME },
  headers: () => Promise.resolve([{ source: '/:path*', headers: securityHeaders }]),
  // Development only: proxy /api to the API so cookies stay first-party.
  // In every other environment the edge proxy routes /api directly to the API
  // and sets a trustworthy X-Forwarded-For. The Next.js proxy forwards a
  // client-supplied X-Forwarded-For unchanged, so it must never front the API
  // outside local development (see docs/decisions/0004-edge-proxy-topology.md).
  rewrites: () =>
    Promise.resolve(
      isDev ? [{ source: '/api/:path*', destination: `${env.API_INTERNAL_URL}/:path*` }] : [],
    ),
};

export default nextConfig;
