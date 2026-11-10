/**
 * Content Security Policy (ADR-0004, ADR-0035). Next.js App Router injects
 * inline bootstrap scripts, so 'unsafe-inline' is required for scripts until
 * nonce-based CSP is adopted (docs/security/threat-model.md). Everything else
 * is same-origin, plus Privy's hosts when email wallets are enabled.
 */
export function buildCsp({
  isDev,
  privy,
  rpcUrls = [],
}: {
  isDev: boolean;
  privy: boolean;
  /** Test network RPCs the email wallet provider calls from the page. */
  rpcUrls?: readonly string[];
}): string {
  // From Privy's CSP guide; re-check it on every SDK upgrade.
  const privyFrames = privy
    ? [
        'https://auth.privy.io',
        'https://verify.walletconnect.com',
        'https://verify.walletconnect.org',
      ]
    : [];
  const privyConnect = privy
    ? [
        'https://auth.privy.io',
        'wss://relay.walletconnect.com',
        'wss://relay.walletconnect.org',
        'wss://www.walletlink.org',
        'https://*.rpc.privy.systems',
        'https://explorer-api.walletconnect.com',
        ...rpcUrls.filter((u) => u.startsWith('https://')).map((u) => new URL(u).origin),
      ]
    : [];
  const captcha = privy ? ['https://challenges.cloudflare.com'] : [];
  const list = (...xs: string[]) => [...new Set(xs)].join(' ');
  return [
    "default-src 'self'",
    `script-src ${list("'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : []), ...captcha)}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${list("'self'", 'data:', ...(privy ? ['blob:'] : []))}`,
    "font-src 'self'",
    `connect-src ${list("'self'", ...(isDev ? ['ws:'] : []), ...privyConnect)}`,
    ...(privy
      ? [
          `frame-src ${list(...privyFrames, ...captcha)}`,
          `child-src ${list(...privyFrames)}`,
          "worker-src 'self'",
        ]
      : []),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}
