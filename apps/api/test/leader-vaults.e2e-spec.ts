import type { INestApplication } from '@nestjs/common';
import { secp256k1 } from '@noble/curves/secp256k1';
import { parseAmount, type PerpConfigInput } from '@platform/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { addressFromPublicKey, personalMessageHash, toChecksumAddress } from '../src/auth/siwe';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { LeaderVaultsService } from '../src/leader-vaults/leader-vaults.service';
import { toMinorUnits } from '../src/ledger/ledger-domain';
import { LedgerService } from '../src/ledger/ledger.service';
import { ReconciliationService } from '../src/ledger/reconciliation.service';
import { MarketsService, type MarketWithAssets } from '../src/trading/markets.service';
import { EngineProcess } from './engine';
import { TestClient, bootApp } from './helpers';
import { SYSTEM, TradingFixture, type Trader } from './trading-helpers';

/** Leader vaults / copy-trading (ADR-0019). */
let app: INestApplication;
let prisma: PrismaService;
let ledger: LedgerService;
let fx: TradingFixture;
const engine = new EngineProcess();
const USD = 1_000_000n;
const code = (p: string) => `${p}${randomBytes(3).toString('hex').toUpperCase()}`;

async function walletUser(): Promise<Trader> {
  const key = secp256k1.utils.randomPrivateKey();
  const address = toChecksumAddress(addressFromPublicKey(secp256k1.getPublicKey(key, false)));
  const client = new TestClient(app);
  const n = (await client.get('/v1/auth/wallet/nonce')).body as {
    nonce: string;
    domain: string;
    uri: string;
  };
  const message = [
    `${n.domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Sign in.',
    '',
    `URI: ${n.uri}`,
    'Version: 1',
    'Chain ID: 1',
    `Nonce: ${n.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n');
  const sig = secp256k1.sign(personalMessageHash(message), key);
  const signature = `0x${Buffer.from(sig.toCompactRawBytes()).toString('hex')}${(27 + sig.recovery).toString(16)}`;
  const login = await client.post('/v1/auth/wallet/login', { message, signature });
  expect(login.status).toBe(200);
  return { client, userId: login.body.user.id as string, email: '' };
}

async function fund(userId: string, asset: string, amount: string) {
  await ledger.simulatedDeposit(
    {
      userId,
      assetCode: asset,
      amount: parseAmount(amount, 6),
      idempotencyKey: `d:${randomUUID()}`,
    },
    SYSTEM,
  );
}

async function avail(userId: string, asset: string): Promise<bigint> {
  const a = await ledger.requireAsset(asset);
  const acc = await prisma.ledgerAccount.findFirst({
    where: { assetId: a.id, type: 'USER_AVAILABLE', ownerUserId: userId },
  });
  return acc ? toMinorUnits(acc.balance) : 0n;
}

async function perp() {
  const base = code('VB');
  const quote = code('VQ');
  await ledger.createAsset({ code: base, name: 'Base', scale: 8 }, SYSTEM);
  await ledger.createAsset({ code: quote, name: 'Quote', scale: 6 }, SYSTEM);
  const markets = app.get(MarketsService);
  const spot = await markets.create(
    { base, quote, tickSize: '0.01', lotSize: '0.0001', makerFeeBps: 0, takerFeeBps: 0 },
    SYSTEM,
  );
  const config: PerpConfigInput = {
    defaultLeverage: 10,
    tiers: [{ maxNotional: '1000000', maxLeverage: 10, mmrBps: 500 }],
    fundingIntervalSeconds: 3600,
    fundingClampBps: 75,
    maxBasisBps: 50,
    liquidationFeeBps: 50,
    priceBandBps: 5000,
    index: {
      sources: [{ type: 'spot', market: spot.symbol }],
      staleSeconds: 30,
      outlierBps: 500,
      minSources: 1,
    },
  };
  const m = await markets.create(
    {
      base,
      quote,
      tickSize: '0.01',
      lotSize: '0.0001',
      makerFeeBps: 0,
      takerFeeBps: 0,
      kind: 'perpetual',
      perp: config,
    },
    SYSTEM,
  );
  return { market: m, symbol: m.symbol, spot: spot.symbol, quote };
}

async function setMark(m: MarketWithAssets, price: bigint) {
  await prisma.perpPriceSample.create({
    data: {
      marketId: m.id,
      sampledAt: new Date(),
      indexPrice: price.toString(),
      markPrice: price.toString(),
      sourcesUsed: 1,
    },
  });
}

/** Sends a request as the vault's trading account (X-Sub-Account). */
async function asVault(leader: Trader, accountId: string, path: string, body: object) {
  const csrf = await leader.client.csrf();
  return leader.client.agent
    .post(path)
    .set('X-Forwarded-For', leader.client.ip)
    .set('X-CSRF-Token', csrf)
    .set('X-Sub-Account', accountId)
    .send(body);
}

beforeAll(async () => {
  app = await bootApp();
  prisma = app.get(PrismaService);
  ledger = app.get(LedgerService);
  fx = new TradingFixture(app, engine);
  await engine.start();
}, 60_000);

afterAll(async () => {
  await engine.stop();
  await app.close();
});

describe('leader vaults', () => {
  it('pool collateral, trade it, and pay profit share only on gains above the mark', async () => {
    const p = await perp();
    await setMark(p.market, 100n * USD);
    const leader = await walletUser();
    const follower = await walletUser();
    await fund(leader.userId, p.quote, '1000');
    await fund(follower.userId, p.quote, '5000');

    const created = await leader.client.post('/v1/leader-vaults', {
      name: `Trend ${code('')}`,
      asset: p.quote,
      profitShareBps: 2000,
      maxLeverage: 5,
      maxDrawdownBps: 5000,
      initialDeposit: '100',
    });
    expect(created.body).toMatchObject({ id: expect.any(String) });
    expect(created.status).toBe(201);
    const vaultId = created.body.id as string;
    const accountId = created.body.accountId as string;

    // The leader must keep at least 5%: 100 of 3100 is too little.
    const tooBig = await follower.client.post(`/v1/leader-vaults/${vaultId}/deposit`, {
      amount: '3000',
      idempotencyKey: 'deposit-big',
    });
    expect(tooBig.status).toBe(409);
    const dep = await follower.client.post(`/v1/leader-vaults/${vaultId}/deposit`, {
      amount: '1000',
      idempotencyKey: 'deposit-001',
    });
    expect(dep.status).toBe(200);
    expect(dep.body.shares).toBe((1000n * USD).toString());

    // The leader trades the vault: leverage within the vault limit, perpetuals only.
    expect(
      (await asVault(leader, accountId, '/v1/perp/leverage', { market: p.symbol, leverage: 10 }))
        .status,
    ).toBe(409);
    expect(
      (await asVault(leader, accountId, '/v1/perp/leverage', { market: p.symbol, leverage: 5 }))
        .status,
    ).toBe(201);
    const spotOrder = await asVault(leader, accountId, '/v1/orders', {
      market: p.spot,
      clientOrderId: randomUUID(),
      side: 'buy',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    expect(spotOrder.status).toBe(403);

    const mm = await fx.trader([{ asset: p.quote, amount: '100000', scale: 6 }]);
    const ask = await fx.place(mm, {
      market: p.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(ask.body.id)) === 'OPEN');
    const buy = await asVault(leader, accountId, '/v1/orders', {
      market: p.symbol,
      clientOrderId: randomUUID(),
      side: 'buy',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    expect(buy.status).toBe(202);
    await fx.until(async () => (await fx.status(buy.body.id)) === 'FILLED');

    // The leader can never move vault funds out.
    const csrf = await leader.client.csrf();
    const out = await leader.client.agent
      .post('/v1/me/sub-accounts/transfer')
      .set('X-Forwarded-For', leader.client.ip)
      .set('X-CSRF-Token', csrf)
      .send({
        from: accountId,
        to: 'main',
        asset: p.quote,
        amount: '1',
        idempotencyKey: 'steal-01',
      });
    expect(out.status).toBe(404);

    // Price rises to 150: +50 unrealised. Equity 1150 over 1100 shares.
    await setMark(p.market, 150n * USD);
    const leaderBefore = await avail(leader.userId, p.quote);
    const followerBefore = await avail(follower.userId, p.quote);
    const r = await follower.client.post(`/v1/leader-vaults/${vaultId}/redeem`, { shares: 'all' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('paid');
    const gross = (1000n * USD * 1150n * USD) / (1100n * USD);
    const gain = gross - 1000n * USD;
    const profitShare = (gain * 2000n) / 10_000n;
    const got = (await avail(follower.userId, p.quote)) - followerBefore;
    const fee = (await avail(leader.userId, p.quote)) - leaderBefore;
    expect(got + fee).toBe(gross);
    expect(fee - profitShare <= 1n && profitShare - fee <= 1n).toBe(true); // rounding
    expect(fee > 0n).toBe(true);

    const run = await app.get(ReconciliationService).run('CLI');
    expect(run.findings).toEqual([]);

    // Terms are fixed forever.
    await expect(
      prisma.leaderVault.update({ where: { id: vaultId }, data: { profitShareBps: 3000 } }),
    ).rejects.toThrow(/terms are fixed/);
    await expect(
      prisma.leaderVault.update({ where: { id: vaultId }, data: { maxLeverage: 2 } }),
    ).resolves.toBeTruthy(); // stricter is allowed
  });

  it('queues an exit that free collateral cannot cover and blocks new risk until paid', async () => {
    const p = await perp();
    await setMark(p.market, 100n * USD);
    const leader = await walletUser();
    const follower = await walletUser();
    await fund(leader.userId, p.quote, '1000');
    await fund(follower.userId, p.quote, '1000');
    const v = await leader.client.post('/v1/leader-vaults', {
      name: `Queue ${code('')}`,
      asset: p.quote,
      profitShareBps: 1000,
      maxLeverage: 2,
      maxDrawdownBps: 5000,
      initialDeposit: '100',
    });
    const vaultId = v.body.id as string;
    const accountId = v.body.accountId as string;
    await follower.client.post(`/v1/leader-vaults/${vaultId}/deposit`, {
      amount: '900',
      idempotencyKey: 'deposit-q01',
    });
    await asVault(leader, accountId, '/v1/perp/leverage', { market: p.symbol, leverage: 2 });
    // Vault buys 7 at 100 with 2x: 350 margin; more than 80% of 1000 equity is refused.
    const mm = await fx.trader([{ asset: p.quote, amount: '100000', scale: 6 }]);
    const tooMuch = await asVault(leader, accountId, '/v1/orders', {
      market: p.symbol,
      clientOrderId: randomUUID(),
      side: 'buy',
      type: 'limit',
      price: '100',
      quantity: '17',
    });
    expect(tooMuch.status).toBe(409);
    const ask = await fx.place(mm, {
      market: p.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '7',
    });
    await fx.until(async () => (await fx.status(ask.body.id)) === 'OPEN');
    const buy = await asVault(leader, accountId, '/v1/orders', {
      market: p.symbol,
      clientOrderId: randomUUID(),
      side: 'buy',
      type: 'limit',
      price: '100',
      quantity: '7',
    });
    await fx.until(async () => (await fx.status(buy.body.id)) === 'FILLED');

    // Free collateral is 650; the follower's 900 must wait.
    const r = await follower.client.post(`/v1/leader-vaults/${vaultId}/redeem`, { shares: 'all' });
    expect(r.body.status).toBe('pending');
    const blocked = await asVault(leader, accountId, '/v1/orders', {
      market: p.symbol,
      clientOrderId: randomUUID(),
      side: 'buy',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/Redemptions are waiting/);

    // The leader closes the position (reduce-only is allowed); the exit is then paid.
    const bid = await fx.place(mm, {
      market: p.symbol,
      side: 'buy',
      type: 'limit',
      price: '100',
      quantity: '7',
    });
    await fx.until(async () => (await fx.status(bid.body.id)) === 'OPEN');
    const close = await asVault(leader, accountId, '/v1/orders', {
      market: p.symbol,
      clientOrderId: randomUUID(),
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '7',
      reduceOnly: true,
    });
    expect(close.status).toBe(202);
    await fx.until(async () => (await fx.status(close.body.id)) === 'FILLED');
    const before = await avail(follower.userId, p.quote);
    expect(await app.get(LeaderVaultsService).payPending(vaultId)).toBe(1);
    expect((await avail(follower.userId, p.quote)) - before).toBe(900n * USD);
  });

  it('never matches a leader against their own vault (self-trade prevention)', async () => {
    const p = await perp();
    await setMark(p.market, 100n * USD);
    const leader = await walletUser();
    await fund(leader.userId, p.quote, '2000');
    const v = await leader.client.post('/v1/leader-vaults', {
      name: `Self ${code('')}`,
      asset: p.quote,
      profitShareBps: 0,
      maxLeverage: 10,
      maxDrawdownBps: 5000,
      initialDeposit: '500',
    });
    const accountId = v.body.accountId as string;
    const own = await fx.place(leader, {
      market: p.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(own.body.id)) === 'OPEN');
    const vaultBuy = await asVault(leader, accountId, '/v1/orders', {
      market: p.symbol,
      clientOrderId: randomUUID(),
      side: 'buy',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(vaultBuy.body.id)) === 'CANCELLED');
    const o = await prisma.order.findUniqueOrThrow({ where: { id: vaultBuy.body.id } });
    expect(o.cancelReason).toMatch(/self_trade/);
    expect(await prisma.trade.count({ where: { takerOrderId: vaultBuy.body.id } })).toBe(0);
  });

  it('publishes track records ranked by return over drawdown', async () => {
    await app.get(LeaderVaultsService).tick();
    const list = await new TestClient(app).get('/v1/leader-vaults');
    expect(list.status).toBe(200);
    expect(list.body.vaults.length).toBeGreaterThan(0);
    const one = list.body.vaults[0];
    expect(one).toHaveProperty('returnSinceInceptionBps');
    expect(one).toHaveProperty('maxDrawdownSeenBps');
    expect(one).toHaveProperty('score');
    const detail = await new TestClient(app).get(`/v1/leader-vaults/${one.id}`);
    expect(detail.body.curve.length).toBeGreaterThan(0);
  });
});
