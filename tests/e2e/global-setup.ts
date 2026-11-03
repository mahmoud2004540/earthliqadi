import { request } from '@playwright/test';
import { PASSWORD, cli, compose, uniqueEmail, verificationLink } from './stack';

/**
 * Creates a FRESH market for every run (unique asset codes), through the real
 * admin paths: audited CLI for assets/roles, the admin API for the market.
 * A fresh order book keeps runs independent of earlier runs' resting orders.
 * The symbol is shared with the tests via process.env.E2E_MARKET.
 */
export default async function globalSetup(): Promise<void> {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  const [base, quote] = [`EB${run}`, `EQ${run}`];
  process.env.E2E_MARKET = `${base}-${quote}`;
  process.env.E2E_BASE = base;
  process.env.E2E_QUOTE = quote;
  const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
  compose(
    'exec',
    '-T',
    'redis',
    'sh',
    '-c',
    "redis-cli --scan --pattern 'rl:*' | xargs -r redis-cli del",
  );
  for (const [code, scale] of [
    [base, '8'],
    [quote, '6'],
  ] as const) {
    cli(
      'dist/cli/ledger.js',
      'create-asset',
      '--code',
      code,
      '--name',
      `E2E test ${code}`,
      '--scale',
      scale,
    );
  }

  const api = await request.newContext({ baseURL });
  {
    const email = uniqueEmail('e2e-risk');
    const csrf = ((await (await api.get('/api/v1/auth/csrf')).json()) as { csrfToken: string })
      .csrfToken;
    const headers = { 'X-CSRF-Token': csrf };
    await api.post('/api/v1/auth/register', {
      headers,
      data: { email, password: PASSWORD, acceptTerms: true },
    });
    await new Promise((r) => setTimeout(r, 1000));
    const token = verificationLink(email).split('#token=')[1];
    await api.post('/api/v1/auth/verify-email', { headers, data: { token } });
    cli(
      'dist/cli/grant-role.js',
      '--email',
      email,
      '--role',
      'risk_officer',
      '--reason',
      'e2e setup',
    );
    const login = await api.post('/api/v1/auth/login', {
      headers,
      data: { email, password: PASSWORD },
    });
    if (!login.ok()) throw new Error(`login failed: ${login.status()}`);
    const created = await api.post('/api/v1/admin/markets', {
      headers,
      data: { base, quote, tickSize: '0.01', lotSize: '0.0001', makerFeeBps: 10, takerFeeBps: 20 },
    });
    if (!created.ok()) throw new Error(`market creation failed: ${created.status()}`);
  }
  await api.dispose();
}
