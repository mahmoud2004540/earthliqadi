import { parseEnv, webEnvSchema } from '@platform/config';
import { TEST_NETWORKS } from '@platform/shared';
import type { NextConfig } from 'next';
import path from 'node:path';
import { buildCsp } from './src/lib/csp';

const env = parseEnv(webEnvSchema);
const isDev = env.NODE_ENV !== 'production';

// Email wallets (ADR-0035) are enabled by setting a Privy app id at build time.
const privy = Boolean(env.NEXT_PUBLIC_PRIVY_APP_ID);
const csp = buildCsp({ isDev, privy, rpcUrls: TEST_NETWORKS.map((n) => n.rpcUrl) });

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
  env: {
    NEXT_PUBLIC_BRAND_NAME: env.NEXT_PUBLIC_BRAND_NAME,
    NEXT_PUBLIC_PRIVY_APP_ID: env.NEXT_PUBLIC_PRIVY_APP_ID ?? '',
  },
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
