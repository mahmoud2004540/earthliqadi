import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';

const directive = (csp: string, name: string) =>
  csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? null;

describe('buildCsp', () => {
  it('stays same-origin when email wallets are off', () => {
    const csp = buildCsp({ isDev: false, privy: false, rpcUrls: ['https://sepolia.base.org'] });
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
    expect(directive(csp, 'frame-src')).toBeNull();
    expect(csp).not.toContain('privy');
    expect(csp).not.toContain('unsafe-eval');
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
  });

  it('allows Privy and the https test network RPCs when email wallets are on', () => {
    const csp = buildCsp({
      isDev: false,
      privy: true,
      rpcUrls: ['https://sepolia.base.org', 'http://localhost:8545', 'https://a.example/rpc'],
    });
    const connect = directive(csp, 'connect-src')!;
    expect(connect).toContain('https://auth.privy.io');
    expect(connect).toContain('https://sepolia.base.org');
    expect(connect).toContain('https://a.example');
    expect(connect).not.toContain('/rpc');
    expect(connect).not.toContain('http://localhost');
    expect(directive(csp, 'frame-src')).toContain('https://auth.privy.io');
    expect(directive(csp, 'script-src')).toContain('https://challenges.cloudflare.com');
    // Never relaxed by Privy:
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
  });

  it('adds unsafe-eval and ws: in development only', () => {
    const csp = buildCsp({ isDev: true, privy: false });
    expect(directive(csp, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(csp, 'connect-src')).toContain('ws:');
  });
});
