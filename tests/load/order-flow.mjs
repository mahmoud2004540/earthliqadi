#!/usr/bin/env node
// Order-flow load measurement against the local Docker Compose stack.
//
//   RATE_LIMIT_DEFAULT_PER_MINUTE=10000000 RATE_LIMIT_AUTH_PER_MINUTE=10000 docker compose up -d --no-build api
//   ORDERS=2000 CONCURRENCY=32 node tests/load/order-flow.mjs
//
// Creates a fresh market and two funded traders (simulated funds), submits
// crossing orders through the edge proxy, waits until the engine and settlement
// have drained, and reports HTTP latency, throughput and per-stage latencies
// measured from database timestamps. Development use only.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const ORDERS = Number(process.env.ORDERS ?? 1000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);
// One trader per worker by default. Orders of ONE user serialise on that user's
// balance rows by design (no double spending), so few traders = artificial contention.
const TRADERS = Number(process.env.TRADERS ?? CONCURRENCY);
const PASSWORD = 'correct horse battery staple 1';

const compose = (...args) =>
  execFileSync('docker', ['compose', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const cli = (...args) => compose('exec', '-T', 'api', 'node', ...args);
const psql = (sql) =>
  compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'exchange',
    '-d',
    'exchange_dev',
    '-tAc',
    sql,
  ).trim();

class Client {
  cookies = new Map();
  csrf = null;
  async req(method, path, body) {
    const headers = {
      'content-type': 'application/json',
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    };
    if (method !== 'GET') headers['x-csrf-token'] = this.csrf;
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  async init() {
    this.csrf = (await this.req('GET', '/v1/auth/csrf')).body.csrfToken;
    return this;
  }
}

async function user(tag) {
  const c = await new Client().init();
  const email = `${tag}-${randomUUID().slice(0, 8)}@example.test`;
  await c.req('POST', '/v1/auth/register', { email, password: PASSWORD, acceptTerms: true });
  await new Promise((r) => setTimeout(r, 800));
  const logs = compose('logs', '--no-log-prefix', '--tail', '2000', 'api');
  const token = [
    ...logs.matchAll(new RegExp(`to=${email}[\\s\\S]*?verify-email#token=([A-Za-z0-9_-]+)`, 'g')),
  ].at(-1)?.[1];
  if (!token) throw new Error(`no verification token for ${email}`);
  await c.req('POST', '/v1/auth/verify-email', { token });
  const login = await c.req('POST', '/v1/auth/login', { email, password: PASSWORD });
  if (login.status !== 200)
    throw new Error(`login failed (${login.status}); raise RATE_LIMIT_* for load runs`);
  return { c, email };
}

const pct = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const summary = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s.at(-1) };
};

async function main() {
  const run = randomUUID()
    .slice(0, 6)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, 'X');
  const [base, quote] = [`LB${run}`, `LQ${run}`];
  cli('dist/cli/ledger.js', 'create-asset', '--code', base, '--name', 'Load base', '--scale', '8');
  cli(
    'dist/cli/ledger.js',
    'create-asset',
    '--code',
    quote,
    '--name',
    'Load quote',
    '--scale',
    '6',
  );
  const risk = await user('load-risk');
  cli(
    'dist/cli/grant-role.js',
    '--email',
    risk.email,
    '--role',
    'risk_officer',
    '--reason',
    'load test',
  );
  await risk.c.req('POST', '/v1/auth/logout');
  await risk.c.init();
  await risk.c.req('POST', '/v1/auth/login', { email: risk.email, password: PASSWORD });
  const m = await risk.c.req('POST', '/v1/admin/markets', {
    base,
    quote,
    tickSize: '0.01',
    lotSize: '0.0001',
    makerFeeBps: 10,
    takerFeeBps: 20,
  });
  if (m.status !== 201) throw new Error(`market creation failed: ${JSON.stringify(m.body)}`);
  const symbol = m.body.symbol;
  const marketId = psql(`select id from markets where symbol='${symbol}'`);

  // Even-indexed traders sell, odd-indexed traders buy (crossing at one price → trades).
  const traders = [];
  for (let i = 0; i < TRADERS; i++) {
    const t = await user(i % 2 === 0 ? 'load-seller' : 'load-buyer');
    if (i % 2 === 0)
      cli(
        'dist/cli/ledger.js',
        'sim-deposit',
        '--email',
        t.email,
        '--asset',
        base,
        '--amount',
        '1000000',
      );
    else
      cli(
        'dist/cli/ledger.js',
        'sim-deposit',
        '--email',
        t.email,
        '--asset',
        quote,
        '--amount',
        '1000000000',
      );
    traders.push({ ...t, side: i % 2 === 0 ? 'sell' : 'buy' });
  }
  const jobs = Array.from({ length: ORDERS }, (_, i) => traders[i % traders.length]);
  const latencies = [];
  let failures = 0;
  const t0 = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < jobs.length) {
        const { side, c } = jobs[next++];
        const start = performance.now();
        const res = await c.req('POST', '/v1/orders', {
          market: symbol,
          clientOrderId: randomUUID(),
          side,
          type: 'limit',
          price: '100',
          quantity: '0.0001',
        });
        latencies.push(performance.now() - start);
        if (res.status !== 202) failures++;
      }
    }),
  );
  const submitted = performance.now();

  for (;;) {
    const s = (await risk.c.req('GET', '/v1/admin/engine/status')).body.markets.find(
      (x) => x.symbol === symbol,
    );
    if (
      s &&
      s.engineBacklog === '0' &&
      s.settlementLag === '0' &&
      s.commandsProcessed === String(ORDERS - failures) // failed submissions never reached the engine
    )
      break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const drained = performance.now();

  const ms = (sql) => psql(sql).split('\n').filter(Boolean).map(Number);
  const engineLatency = ms(`
    select extract(epoch from (min(e.created_at) - c.created_at)) * 1000
      from engine_commands c join engine_events e on e.market_id = c.market_id and e.command_seq = c.seq
     where c.market_id = '${marketId}' group by c.seq, c.created_at`);
  const settlementLatency = ms(`
    select extract(epoch from (created_at - executed_at)) * 1000 from trades where market_id = '${marketId}'`);
  const trades = Number(psql(`select count(*) from trades where market_id='${marketId}'`));
  const recon = cli('dist/cli/ledger.js', 'reconcile').trim().split('\n').at(-1);

  const round = (o) =>
    Object.fromEntries(
      Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 10) / 10 : v]),
    );
  console.log(
    JSON.stringify(
      {
        orders: ORDERS,
        concurrency: CONCURRENCY,
        traders: TRADERS,
        failures,
        trades,
        submitSeconds: round({ v: (submitted - t0) / 1000 }).v,
        drainSeconds: round({ v: (drained - t0) / 1000 }).v,
        ordersPerSecondEndToEnd: Math.round(ORDERS / ((drained - t0) / 1000)),
        httpOrderEntryMs: round(summary(latencies)),
        commandToEngineEventMs: round(summary(engineLatency)),
        fillToSettlementMs: round(summary(settlementLatency)),
        reconciliation: recon,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
