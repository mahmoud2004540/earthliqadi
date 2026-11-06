import type { INestApplication } from '@nestjs/common';
import { secp256k1 } from '@noble/curves/secp256k1';
import { parseAmount } from '@platform/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { addressFromPublicKey, personalMessageHash, toChecksumAddress } from '../src/auth/siwe';
import { GrowthService } from '../src/growth/growth.service';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { toMinorUnits } from '../src/ledger/ledger-domain';
import { LedgerService } from '../src/ledger/ledger.service';
import { ReconciliationService } from '../src/ledger/reconciliation.service';
import { MarketsService } from '../src/trading/markets.service';
import { EngineProcess } from './engine';
import { TestClient, bootApp } from './helpers';
import { SYSTEM, TradingFixture, type Trader } from './trading-helpers';

/** Fee tiers, maker rebates, referral fee share and points (ADR-0018). */
let app: INestApplication;
let prisma: PrismaService;
let ledger: LedgerService;
let fx: TradingFixture;
const engine = new EngineProcess();
const code = (p: string) => `${p}${randomBytes(3).toString('hex').toUpperCase()}`;

async function walletUser(referralCode?: string): Promise<Trader & { w: string }> {
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
  const login = await client.post('/v1/auth/wallet/login', {
    message,
    signature,
    ...(referralCode ? { referralCode } : {}),
  });
  expect(login.status).toBe(200);
  return { client, userId: login.body.user.id as string, email: '', w: address };
}

async function fund(userId: string, asset: string, amount: string, scale: number) {
  await ledger.simulatedDeposit(
    {
      userId,
      assetCode: asset,
      amount: parseAmount(amount, scale),
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

/** A USD-quoted market (counts towards volume): base scale 8, quote scale 6. */
async function usdMarket(fees: { makerFeeBps: number; takerFeeBps: number }) {
  const base = code('GB');
  const quote = code('USD');
  await ledger.createAsset({ code: base, name: 'Base', scale: 8 }, SYSTEM);
  await ledger.createAsset({ code: quote, name: 'Quote USD', scale: 6 }, SYSTEM);
  const m = await app
    .get(MarketsService)
    .create({ base, quote, tickSize: '0.01', lotSize: '0.0001', ...fees }, SYSTEM);
  return { symbol: m.symbol, base, quote, id: m.id };
}

async function fill(maker: Trader, taker: Trader, market: string, side: 'buy' | 'sell') {
  const rest = await fx.place(maker, {
    market,
    side: side === 'buy' ? 'sell' : 'buy',
    type: 'limit',
    price: '100',
    quantity: '1',
  });
  expect(rest.status).toBe(202);
  await fx.until(async () => (await fx.status(rest.body.id)) === 'OPEN');
  const take = await fx.place(taker, { market, side, type: 'limit', price: '100', quantity: '1' });
  expect(take.status).toBe(202);
  await fx.until(async () => (await fx.status(take.body.id)) === 'FILLED');
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

describe('referrals', () => {
  it('attach only at account creation, only for wallet accounts, and never change', async () => {
    const referrer = await walletUser();
    const created = await referrer.client.post('/v1/me/referrals/code', {});
    expect(created.status).toBe(201);
    const refCode = created.body.code as string;
    expect((await referrer.client.post('/v1/me/referrals/code', {})).body.code).toBe(refCode);

    const referee = await walletUser(refCode);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: referee.userId } });
    expect(row.referredByUserId).toBe(referrer.userId);
    expect((await referrer.client.get('/v1/me/referrals')).body).toMatchObject({
      code: refCode,
      referred: 1,
    });
    await expect(
      prisma.user.update({ where: { id: referee.userId }, data: { referredByUserId: null } }),
    ).rejects.toThrow(/set once/);
    // Unknown codes are ignored rather than failing sign-in.
    const stranger = await walletUser('zzzzzzzz');
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: stranger.userId } })).referredByUserId,
    ).toBeNull();
  });
});

describe('fees, rebates and referral share', () => {
  it('splits the taker fee into maker rebate, referral share and revenue (spot)', async () => {
    const m = await usdMarket({ makerFeeBps: 0, takerFeeBps: 100 });
    const referrer = await walletUser();
    const refCode = (await referrer.client.post('/v1/me/referrals/code', {})).body.code as string;
    const taker = await walletUser(refCode);
    await fund(taker.userId, m.quote, '1000', 6);
    const maker = await fx.trader([{ asset: m.base, amount: '5', scale: 8 }]);
    // The maker is on tier 4 (4 bps maker discount): effective maker fee -4 bps = rebate.
    await prisma.userFeeTier.create({
      data: { userId: maker.userId, tier: 4, volume30d: '0', computedAt: new Date() },
    });
    await fill(maker, taker, m.symbol, 'buy');

    // Taker fee: 1% of 1 base = 0.01 base. Rebate 4 bps of 1 = 0.0004. Referral 10% of the rest.
    const takerFee = 1_000_000n; // 0.01 at scale 8
    const rebate = 40_000n;
    const referral = (takerFee - rebate) / 10n;
    expect(await avail(taker.userId, m.base)).toBe(100_000_000n - takerFee);
    expect(await avail(maker.userId, m.base)).toBe(400_000_000n + rebate);
    expect(await avail(referrer.userId, m.base)).toBe(referral);
    const payouts = await prisma.feePayout.findMany({ where: { sourceUserId: taker.userId } });
    expect(payouts.map((p) => [p.kind, toMinorUnits(p.amount)]).sort()).toEqual(
      [
        ['maker_rebate', rebate],
        ['referral', referral],
      ].sort(),
    );
    const summary = (await referrer.client.get('/v1/me/referrals')).body;
    expect(summary.earnings).toEqual([{ asset: m.base, amount: '0.00096' }]);
    const run = await app.get(ReconciliationService).run('CLI');
    expect(run.findings).toEqual([]);
  });

  it('publishes the schedule and recomputes tiers and points from trades, excluding wash pairs', async () => {
    const schedule = await new TestClient(app).get('/v1/fees/schedule');
    expect(schedule.status).toBe(200);
    expect(schedule.body.tiers[0]).toMatchObject({ tier: 0, takerDiscountBps: 0 });
    expect(schedule.body.referralShareBps).toBe(1000);

    const m = await usdMarket({ makerFeeBps: 0, takerFeeBps: 0 });
    const maker = await fx.trader([{ asset: m.base, amount: '5', scale: 8 }]);
    const taker = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    await fill(maker, taker, m.symbol, 'buy'); // 100 units of volume
    // Wash pair: X and Y trade only with each other, back and forth.
    const x = await fx.trader([
      { asset: m.base, amount: '5', scale: 8 },
      { asset: m.quote, amount: '1000', scale: 6 },
    ]);
    const y = await fx.trader([
      { asset: m.base, amount: '5', scale: 8 },
      { asset: m.quote, amount: '1000', scale: 6 },
    ]);
    await fill(x, y, m.symbol, 'buy');
    await fill(y, x, m.symbol, 'buy');

    await app.get(GrowthService).recompute();
    const tier = await prisma.userFeeTier.findUniqueOrThrow({ where: { userId: taker.userId } });
    expect(toMinorUnits(tier.volume30d)).toBe(100_000_000n); // 100 units at 6 decimals
    expect(tier.tier).toBe(0);
    expect((await taker.client.get('/v1/me/fees')).body).toMatchObject({
      tier: 0,
      volume30d: '100',
    });

    expect((await taker.client.get('/v1/me/points')).body.points).toBe('100'); // 1 per taker unit
    expect((await maker.client.get('/v1/me/points')).body.points).toBe('200'); // 2 per maker unit
    const wash = (await x.client.get('/v1/me/points')).body;
    expect(wash).toEqual({ points: '0', excludedVolume: '200' });

    const board = await new TestClient(app).get('/v1/points/leaderboard?days=7');
    expect(board.status).toBe(200);
    expect(board.body.note).toMatch(/not a token/);
    expect(board.body.entries.length).toBeGreaterThan(0);
  });
});
