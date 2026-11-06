import { request } from '@playwright/test';
import { PASSWORD, cli, compose, totp, uniqueEmail, verificationLink } from './stack';

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
  // The perpetual gets its own spot market for its index, so other tests'
  // orders cannot move its price.
  const [ib, iq] = [`IB${run}`, `IQ${run}`];
  process.env.E2E_INDEX_MARKET = `${ib}-${iq}`;
  process.env.E2E_PERP_MARKET = `${ib}-${iq}-PERP`;
  process.env.E2E_VAULT_USD = `TUSD${run}`;
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
    [ib, '8'],
    [iq, '6'],
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
    // Staff permissions require MFA (ADR-0012): enrol TOTP like a real staff member.
    const setup = await api.post('/api/v1/me/mfa/totp/setup', {
      headers,
      data: { password: PASSWORD },
    });
    if (!setup.ok()) throw new Error(`MFA setup failed: ${setup.status()}`);
    const { secret } = (await setup.json()) as { secret: string };
    const enabled = await api.post('/api/v1/me/mfa/totp/enable', {
      headers,
      data: { code: totp(secret) },
    });
    if (!enabled.ok()) throw new Error(`MFA enable failed: ${enabled.status()}`);
    // Market creation is a sensitive action: step up with the NEXT code (replay-protected).
    const stepUp = await api.post('/api/v1/auth/step-up', {
      headers,
      data: { code: totp(secret, Date.now() + 30_000) },
    });
    if (!stepUp.ok()) throw new Error(`step-up failed: ${stepUp.status()}`);
    const created = await api.post('/api/v1/admin/markets', {
      headers,
      data: { base, quote, tickSize: '0.01', lotSize: '0.0001', makerFeeBps: 10, takerFeeBps: 20 },
    });
    if (!created.ok()) throw new Error(`market creation failed: ${created.status()}`);
    const index = await api.post('/api/v1/admin/markets', {
      headers,
      data: {
        base: ib,
        quote: iq,
        tickSize: '0.01',
        lotSize: '0.0001',
        makerFeeBps: 0,
        takerFeeBps: 0,
      },
    });
    if (!index.ok()) throw new Error(`index market creation failed: ${index.status()}`);
    // Perpetual whose index is the spot mid of the index market (ADR-0016).
    const perp = await api.post('/api/v1/admin/markets', {
      headers,
      data: {
        base: ib,
        quote: iq,
        tickSize: '0.01',
        lotSize: '0.0001',
        makerFeeBps: 2,
        takerFeeBps: 5,
        kind: 'perpetual',
        perp: {
          defaultLeverage: 10,
          tiers: [
            { maxNotional: '100000', maxLeverage: 20, mmrBps: 250 },
            { maxNotional: '1000000', maxLeverage: 10, mmrBps: 500 },
          ],
          fundingIntervalSeconds: 3600,
          fundingClampBps: 75,
          maxBasisBps: 50,
          liquidationFeeBps: 50,
          priceBandBps: 1000,
          index: {
            sources: [{ type: 'spot', market: `${ib}-${iq}` }],
            staleSeconds: 120,
            outlierBps: 500,
            minSources: 1,
          },
        },
      },
    });
    if (!perp.ok())
      throw new Error(`perp market creation failed: ${perp.status()} ${await perp.text()}`);
  }
  await api.dispose();
  // A fresh vault + test tokens on the local chain for this run (ADR-0014).
  cli('dist/cli/chain.js', 'deploy', '--suffix', run, '--freeze-delay', '604800');
}
