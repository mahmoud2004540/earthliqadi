import type { INestApplication } from '@nestjs/common';
import { secp256k1 } from '@noble/curves/secp256k1';
import { parseAmount } from '@platform/shared';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import request from 'supertest';
import { canonicalRequest } from '../src/api-keys/api-key-auth';
import { addressFromPublicKey, personalMessageHash, toChecksumAddress } from '../src/auth/siwe';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { OrdersService } from '../src/trading/orders.service';
import { EngineProcess } from './engine';
import { TestClient, bootApp } from './helpers';
import { WsClient, portOf } from './trading-helpers';
import { SYSTEM, TradingFixture } from './trading-helpers';

/** Agent API keys, batch orders, cancel-all and the dead-man switch (ADR-0017). */
let app: INestApplication;
let prisma: PrismaService;
let fx: TradingFixture;
const engine = new EngineProcess();

function wallet() {
  const key = secp256k1.utils.randomPrivateKey();
  const address = toChecksumAddress(addressFromPublicKey(secp256k1.getPublicKey(key, false)));
  const signMessage = (message: string) => {
    const sig = secp256k1.sign(personalMessageHash(message), key);
    return `0x${Buffer.from(sig.toCompactRawBytes()).toString('hex')}${(27 + sig.recovery).toString(16)}`;
  };
  return { address, sign: signMessage };
}

async function walletUser() {
  const w = wallet();
  const client = new TestClient(app);
  const n = (await client.get('/v1/auth/wallet/nonce')).body as {
    nonce: string;
    domain: string;
    uri: string;
  };
  const message = [
    `${n.domain} wants you to sign in with your Ethereum account:`,
    w.address,
    '',
    'Sign in.',
    '',
    `URI: ${n.uri}`,
    'Version: 1',
    'Chain ID: 1',
    `Nonce: ${n.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n');
  const login = await client.post('/v1/auth/wallet/login', {
    message,
    signature: w.sign(message),
  });
  expect(login.status).toBe(200);
  return { w, client, userId: login.body.user.id as string };
}

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { publicKey: raw.toString('hex'), privateKey };
}

/** Signed request with an agent key (no cookies, no CSRF token). */
function keyed(keyId: string, privateKey: KeyObject) {
  const server = app.getHttpServer();
  const go = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: object, ts = Date.now()) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const signature = sign(
      null,
      Buffer.from(canonicalRequest(String(ts), method, path, text)),
      privateKey,
    ).toString('base64');
    let r =
      method === 'GET'
        ? request(server).get(path)
        : method === 'POST'
          ? request(server).post(path)
          : request(server).delete(path);
    r = r
      .set('X-API-Key', keyId)
      .set('X-API-Timestamp', String(ts))
      .set('X-API-Signature', signature);
    if (body !== undefined) r = r.set('Content-Type', 'application/json').send(text);
    return { r, signature, ts, text };
  };
  return go;
}

async function authorize(
  u: Awaited<ReturnType<typeof walletUser>>,
  opts: { scopes?: string[]; allowedIps?: string[] } = {},
) {
  const k = ed25519();
  const ch = await u.client.post('/v1/me/api-keys/challenge', {
    label: 'bot',
    publicKey: k.publicKey,
    scopes: opts.scopes ?? ['read', 'trade'],
    allowedIps: opts.allowedIps ?? [],
    expiresInDays: 30,
  });
  expect(ch.status).toBe(201);
  expect(ch.body.message).toContain('It can never withdraw funds.');
  const created = await u.client.post('/v1/me/api-keys', {
    challengeId: ch.body.challengeId,
    signature: u.w.sign(ch.body.message as string),
  });
  expect(created.status).toBe(201);
  return { id: created.body.id as string, ...k };
}

beforeAll(async () => {
  app = await bootApp();
  prisma = app.get(PrismaService);
  fx = new TradingFixture(app, engine);
  await app.listen(0, '127.0.0.1'); // WebSockets need a listening server
  await engine.start();
}, 60_000);

afterAll(async () => {
  await engine.stop();
  await app.close();
});

describe('agent API keys', () => {
  it('are authorised by the wallet and can read and trade, never withdraw or manage keys', async () => {
    const m = await fx.market();
    const u = await walletUser();
    await app.get(LedgerService).simulatedDeposit(
      {
        userId: u.userId,
        assetCode: m.quote,
        amount: parseAmount('1000', 6),
        idempotencyKey: `dep:${randomUUID()}`,
      },
      SYSTEM,
    );
    const key = await authorize(u);
    const api = keyed(key.id, key.privateKey);

    const balances = await api('GET', '/v1/me/balances').r;
    expect(balances.status).toBe(200);
    expect(
      balances.body.balances.find((b: { asset: string }) => b.asset === m.quote).available,
    ).toBe('1000.000000');
    const placed = await api('POST', '/v1/orders', {
      market: m.symbol,
      clientOrderId: randomUUID(),
      side: 'buy',
      type: 'limit',
      price: '10',
      quantity: '1',
    }).r;
    expect(placed.status).toBe(202);

    // Allow-list: everything else refuses API keys.
    for (const [method, path, body] of [
      ['POST', '/v1/vault/withdrawals', { asset: m.quote, amount: '1' }],
      ['POST', '/v1/me/api-keys/challenge', {}],
      ['GET', '/v1/me/sessions', undefined],
    ] as const) {
      const res = await api(method, path, body).r;
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_NOT_ALLOWED');
    }
    // The key list shows it, with its scopes.
    const list = await u.client.get('/v1/me/api-keys');
    expect(list.body.keys[0]).toMatchObject({ id: key.id, scopes: ['read', 'trade'] });
  });

  it('rejects replays, stale timestamps, bad signatures, wrong scopes, other networks and revoked keys', async () => {
    const u = await walletUser();
    const key = await authorize(u);
    const api = keyed(key.id, key.privateKey);
    const first = api('GET', '/v1/me/balances');
    expect((await first.r).status).toBe(200);
    // Same signature again.
    const replay = await request(app.getHttpServer())
      .get('/v1/me/balances')
      .set('X-API-Key', key.id)
      .set('X-API-Timestamp', String(first.ts))
      .set('X-API-Signature', first.signature);
    expect(replay.status).toBe(401);
    expect((await api('GET', '/v1/me/balances', undefined, Date.now() - 60_000).r).status).toBe(
      401,
    );
    const other = ed25519();
    expect((await keyed(key.id, other.privateKey)('GET', '/v1/me/balances').r).status).toBe(401);

    const readOnly = await authorize(u, { scopes: ['read'] });
    const ro = await keyed(readOnly.id, readOnly.privateKey)('POST', '/v1/orders/cancel-all', {}).r;
    expect(ro.status).toBe(403);
    expect(ro.body.error.code).toBe('API_KEY_NOT_ALLOWED');

    const fenced = await authorize(u, { allowedIps: ['192.0.2.0/24'] });
    const fencedRes = await keyed(fenced.id, fenced.privateKey)('GET', '/v1/me/balances').r;
    expect(fencedRes.status).toBe(403);
    expect(fencedRes.body.error.code).toBe('IP_NOT_ALLOWED');

    expect((await u.client.delete(`/v1/me/api-keys/${key.id}`)).status).toBe(200);
    expect((await api('GET', '/v1/me/balances').r).status).toBe(401);
  });

  it('needs the account’s own wallet signature, and the database fences scopes and history', async () => {
    const u = await walletUser();
    const k = ed25519();
    const ch = await u.client.post('/v1/me/api-keys/challenge', {
      label: 'bot',
      publicKey: k.publicKey,
      scopes: ['trade'],
      expiresInDays: 1,
    });
    const stranger = wallet();
    const bad = await u.client.post('/v1/me/api-keys', {
      challengeId: ch.body.challengeId,
      signature: stranger.sign(ch.body.message as string),
    });
    expect(bad.status).toBe(401);
    // Email accounts (staff) cannot create keys.
    const { createVerifiedUser } = await import('./helpers');
    const email = await createVerifiedUser(app);
    const refused = await email.post('/v1/me/api-keys/challenge', {
      label: 'bot',
      publicKey: ed25519().publicKey,
      scopes: ['read'],
      expiresInDays: 1,
    });
    expect(refused.status).toBe(403);

    const key = await authorize(u);
    await expect(
      prisma.$executeRaw`UPDATE "api_keys" SET "scopes" = ARRAY['read','trade','withdraw'] WHERE "id" = ${key.id}::uuid`,
    ).rejects.toThrow(/immutable|api_keys_scopes_chk/);
    await expect(
      prisma.apiKey.create({
        data: {
          id: randomUUID(),
          userId: u.userId,
          label: 'x',
          publicKey: ed25519().publicKey,
          scopes: ['withdraw'],
          authorizationMessage: 'x',
          authorizationSignature: '0x',
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow(/api_keys_scopes_chk/);
  });
});

describe('agent API keys on the WebSocket', () => {
  it('authenticate the private orders channel without a browser origin; bad signatures are refused', async () => {
    const m = await fx.market();
    const u = await walletUser();
    await app.get(LedgerService).simulatedDeposit(
      {
        userId: u.userId,
        assetCode: m.quote,
        amount: parseAmount('100', 6),
        idempotencyKey: `dep:${randomUUID()}`,
      },
      SYSTEM,
    );
    const key = await authorize(u, { scopes: ['read'] });
    const headers = (privateKey: KeyObject, ts = Date.now()) => ({
      'X-API-Key': key.id,
      'X-API-Timestamp': String(ts),
      'X-API-Signature': sign(
        null,
        Buffer.from(canonicalRequest(String(ts), 'GET', '/ws', '')),
        privateKey,
      ).toString('base64'),
    });
    await expect(
      WsClient.connect(portOf(app), { origin: null, headers: headers(ed25519().privateKey) }),
    ).rejects.toThrow(/401/);
    const ws = await WsClient.connect(portOf(app), {
      origin: null,
      headers: headers(key.privateKey),
    });
    ws.send({ op: 'subscribe', channel: 'orders', market: m.symbol });
    expect(await ws.next((x) => x.type === 'orders')).toMatchObject({ data: [] });
    const placed = await u.client.post('/v1/orders', {
      market: m.symbol,
      clientOrderId: randomUUID(),
      side: 'buy',
      type: 'limit',
      price: '10',
      quantity: '1',
    });
    expect(placed.status).toBe(202);
    await fx.until(async () => (await fx.status(placed.body.id)) === 'OPEN');
    const update = await ws.next(
      (x) =>
        x.type === 'orders' && (x.data as { id: string }[]).some((o) => o.id === placed.body.id),
    );
    expect(update).toBeTruthy();
    ws.close();
  });
});

describe('batch orders, cancel-all and the dead-man switch', () => {
  it('places a batch with per-order results and cancels everything at once', async () => {
    const m = await fx.market();
    const t = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const order = (price: string) => ({
      market: m.symbol,
      clientOrderId: randomUUID(),
      side: 'buy',
      type: 'limit',
      price,
      quantity: '1',
    });
    const res = await t.client.post('/v1/orders/batch', {
      orders: [order('10'), { ...order('11'), quantity: '0.00001' }, order('12')],
    });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { status: number }) => r.status)).toEqual([202, 400, 202]);
    const ids = res.body.results
      .filter((r: { order?: { id: string } }) => r.order)
      .map((r: { order: { id: string } }) => r.order.id) as string[];
    await fx.until(async () => (await fx.status(ids[1]!)) === 'OPEN');

    const cancel = await t.client.post('/v1/orders/cancel-all', { market: m.symbol });
    expect(cancel.status).toBe(202);
    expect(cancel.body.cancelRequested).toBe(2);
    for (const id of ids) await fx.until(async () => (await fx.status(id)) === 'CANCELLED');
  });

  it('cancels all open orders when the dead-man switch is not refreshed', async () => {
    const m = await fx.market();
    const t = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const placed = await fx.place(t, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '10',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(placed.body.id)) === 'OPEN');
    const set = await t.client.post('/v1/orders/cancel-after', { timeoutSeconds: 5 });
    expect(set.status).toBe(200);
    const orders = app.get(OrdersService);
    // Not yet due.
    await orders.fireCancelTimers(new Date());
    expect(await fx.status(placed.body.id)).toBe('OPEN');
    // Due: everything is cancelled and the timer is cleared.
    expect(await orders.fireCancelTimers(new Date(Date.now() + 6_000))).toBeGreaterThanOrEqual(1);
    await fx.until(async () => (await fx.status(placed.body.id)) === 'CANCELLED');
    expect(await prisma.cancelAllTimer.findUnique({ where: { userId: t.userId } })).toBeNull();
    // 0 disables.
    await t.client.post('/v1/orders/cancel-after', { timeoutSeconds: 30 });
    expect((await t.client.post('/v1/orders/cancel-after', { timeoutSeconds: 0 })).body).toEqual({
      deadline: null,
    });
  });
});

describe('sub-accounts', () => {
  it('trade separately under one wallet, funded only by own transfers', async () => {
    const m = await fx.market();
    const u = await walletUser();
    await app.get(LedgerService).simulatedDeposit(
      {
        userId: u.userId,
        assetCode: m.quote,
        amount: parseAmount('1000', 6),
        idempotencyKey: `dep:${randomUUID()}`,
      },
      SYSTEM,
    );
    const created = await u.client.post('/v1/me/sub-accounts', { label: 'market making' });
    expect(created.status).toBe(201);
    const subId = created.body.id as string;
    expect((await u.client.get('/v1/me/sub-accounts')).body.subAccounts).toEqual([
      expect.objectContaining({ id: subId, label: 'market making' }),
    ]);

    // Move 300 to the sub-account; a retry with the same key does not move it twice.
    const xfer = {
      from: 'main',
      to: subId,
      asset: m.quote,
      amount: '300',
      idempotencyKey: 'xfer-0001',
    };
    expect((await u.client.post('/v1/me/sub-accounts/transfer', xfer)).body.replayed).toBe(false);
    expect((await u.client.post('/v1/me/sub-accounts/transfer', xfer)).body.replayed).toBe(true);
    const asSub = (path: string) => u.client.get(path).set('X-Sub-Account', subId);
    const subBal = (await asSub('/v1/me/balances')).body.balances.find(
      (b: { asset: string }) => b.asset === m.quote,
    );
    expect(subBal.available).toBe('300.000000');
    const mainBal = (await u.client.get('/v1/me/balances')).body.balances.find(
      (b: { asset: string }) => b.asset === m.quote,
    );
    expect(mainBal.available).toBe('700.000000');

    // Orders placed as the sub-account hold the sub-account's funds.
    const csrf = await u.client.csrf();
    const placed = await u.client.agent
      .post('/v1/orders')
      .set('X-Forwarded-For', u.client.ip)
      .set('X-CSRF-Token', csrf)
      .set('X-Sub-Account', subId)
      .send({
        market: m.symbol,
        clientOrderId: randomUUID(),
        side: 'buy',
        type: 'limit',
        price: '100',
        quantity: '1',
      });
    expect(placed.status).toBe(202);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.body.id } });
    expect(order.userId).toBe(subId);
    expect(
      (await asSub('/v1/me/balances')).body.balances.find(
        (b: { asset: string }) => b.asset === m.quote,
      ).locked,
    ).toBe('100.000000');

    // Not on account routes; not someone else's sub-account; not more than the balance.
    expect((await asSub('/v1/me/sessions')).status).toBe(403);
    const other = await walletUser();
    expect((await other.client.get('/v1/me/balances').set('X-Sub-Account', subId)).status).toBe(
      404,
    );
    const tooMuch = await u.client.post('/v1/me/sub-accounts/transfer', {
      ...xfer,
      amount: '5000',
      idempotencyKey: 'xfer-0002',
    });
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    expect(
      (
        await other.client.post('/v1/me/sub-accounts/transfer', {
          ...xfer,
          idempotencyKey: 'xfer-0003',
        })
      ).status,
    ).toBe(404);
  });

  it('the database keeps sub-accounts credential-free, one level deep and permanently owned', async () => {
    const u = await walletUser();
    const sub = (await u.client.post('/v1/me/sub-accounts', { label: 'one' })).body.id as string;
    await expect(
      prisma.user.update({ where: { id: sub }, data: { email: 'x@example.test' } }),
    ).rejects.toThrow(/users_credential_chk/);
    await expect(
      prisma.user.create({ data: { parentUserId: sub, label: 'nested', status: 'ACTIVE' } }),
    ).rejects.toThrow(/sub-account parent/);
    const other = await walletUser();
    await expect(
      prisma.user.update({ where: { id: sub }, data: { parentUserId: other.userId } }),
    ).rejects.toThrow(/immutable/);
  });
});
