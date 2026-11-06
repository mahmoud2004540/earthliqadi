import type { INestApplication } from '@nestjs/common';
import { secp256k1 } from '@noble/curves/secp256k1';
import { randomBytes, randomUUID } from 'node:crypto';
import { AccessService } from '../src/access/access.service';
import { OFAC_SOURCE } from '../src/access/ofac';
import { SanctionsSyncService } from '../src/access/sanctions-sync.service';
import { addressFromPublicKey, personalMessageHash, toChecksumAddress } from '../src/auth/siwe';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { TestClient, bootApp } from './helpers';
import { TEST_TERMS_VERSION } from './test-database';
import { TradingFixture } from './trading-helpers';
import { EngineProcess } from './engine';

/** Access policy (ADR-0022): restricted regions, sanctions screening, terms of use. */
const GEO_HEADER = 'x-test-country';
const REGION_HEADER = 'x-test-region';
const GEO_ENV = {
  GEO_COUNTRY_HEADER: GEO_HEADER,
  GEO_REGION_HEADER: REGION_HEADER,
  GEO_UNKNOWN_COUNTRY: 'allow',
  RESTRICTED_COUNTRIES: 'US,KP',
  RESTRICTED_SUBDIVISIONS: 'CA-ON',
  // This file covers the reduce-only mode; access-block.e2e-spec.ts covers block_all.
  GEO_RESTRICTED_MODE: 'reduce_only',
};

let app: INestApplication;
let prisma: PrismaService;
let access: AccessService;
let fx: TradingFixture;
let saved: Record<string, string | undefined>;

beforeAll(async () => {
  saved = Object.fromEntries(Object.keys(GEO_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, GEO_ENV);
  app = await bootApp();
  prisma = app.get(PrismaService);
  access = app.get(AccessService);
  // The engine is not started: these tests stop at the access gate or at enqueueing.
  fx = new TradingFixture(app, new EngineProcess());
}, 60_000);

afterAll(async () => {
  await app.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function postFrom(client: TestClient, path: string, body: object, country?: string) {
  const token = await client.csrf();
  const req = client.agent.post(path).set('X-Forwarded-For', client.ip).set('X-CSRF-Token', token);
  // "CA-ON" sets both headers, the way the edge forwards Cloudflare's location.
  if (country) {
    const [c, region] = country.split('-');
    req.set(GEO_HEADER, c!);
    if (region) req.set(REGION_HEADER, region);
  }
  return req.send(body);
}

function wallet() {
  const key = secp256k1.utils.randomPrivateKey();
  const address = toChecksumAddress(addressFromPublicKey(secp256k1.getPublicKey(key, false)));
  const sign = (message: string) => {
    const sig = secp256k1.sign(personalMessageHash(message), key);
    return `0x${Buffer.from(sig.toCompactRawBytes()).toString('hex')}${(27 + sig.recovery).toString(16)}`;
  };
  return { address, sign };
}

async function walletSignIn(w: ReturnType<typeof wallet>, country?: string) {
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
  const res = await postFrom(
    client,
    '/v1/auth/wallet/login',
    { message, signature: w.sign(message) },
    country,
  );
  return { client, res };
}

const order = (symbol: string, extra: Record<string, unknown> = {}) => ({
  clientOrderId: randomUUID(),
  market: symbol,
  side: 'buy',
  type: 'limit',
  price: '10',
  quantity: '1',
  ...extra,
});

describe('terms of use', () => {
  it('blocks trading until the current version is accepted, then allows it', async () => {
    const m = await fx.market();
    const t = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    await prisma.user.update({
      where: { id: t.userId },
      data: { termsAcceptedVersion: null, termsAcceptedAt: null },
    });

    const blocked = await fx.place(t, order(m.symbol));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('TERMS_NOT_ACCEPTED');

    const status = await t.client.get('/v1/me/access');
    expect(status.body).toMatchObject({
      termsVersion: TEST_TERMS_VERSION,
      termsAccepted: false,
      sanctioned: false,
    });

    const stale = await t.client.post('/v1/me/terms/accept', { version: 'older-version' });
    expect(stale.status).toBe(409);

    const ok = await t.client.post('/v1/me/terms/accept', { version: TEST_TERMS_VERSION });
    expect(ok.status).toBe(200);
    expect(ok.body.termsAccepted).toBe(true);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'access.terms.accepted', actorUserId: t.userId },
    });
    expect(audit).not.toBeNull();

    expect((await fx.place(t, order(m.symbol))).status).toBe(202);
  });

  it('a changed version requires accepting again', async () => {
    const m = await fx.market();
    const t = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    await prisma.user.update({
      where: { id: t.userId },
      data: { termsAcceptedVersion: 'previous-version' },
    });
    const blocked = await fx.place(t, order(m.symbol));
    expect(blocked.body.error.code).toBe('TERMS_NOT_ACCEPTED');
  });
});

describe('restricted regions', () => {
  it('reports the region status publicly', async () => {
    const client = new TestClient(app);
    const us = await client.get('/v1/access').set(GEO_HEADER, 'us');
    expect(us.body).toEqual({
      country: 'US',
      subdivision: null,
      regionRestricted: true,
      restrictedMode: 'reduce_only',
      restrictedCountries: ['US', 'KP'],
      restrictedSubdivisions: ['CA-ON'],
      termsVersion: TEST_TERMS_VERSION,
    });
    const de = await client.get('/v1/access').set(GEO_HEADER, 'DE');
    expect(de.body.regionRestricted).toBe(false);
  });

  it('restricts a subdivision (Ontario) but not the rest of its country', async () => {
    const client = new TestClient(app);
    const on = await client.get('/v1/access').set(GEO_HEADER, 'CA').set(REGION_HEADER, 'ON');
    expect(on.body).toMatchObject({ country: 'CA', subdivision: 'CA-ON', regionRestricted: true });
    const qc = await client.get('/v1/access').set(GEO_HEADER, 'CA').set(REGION_HEADER, 'QC');
    expect(qc.body.regionRestricted).toBe(false);

    const m = await fx.market();
    const t = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const blocked = await postFrom(t.client, '/v1/orders', order(m.symbol), 'CA-ON');
    expect(blocked.status).toBe(451);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'access.denied', actorUserId: t.userId },
    });
    expect(audit?.metadata).toMatchObject({ country: 'CA', subdivision: 'CA-ON' });
    expect((await postFrom(t.client, '/v1/orders', order(m.symbol), 'CA-QC')).status).toBe(202);
  });

  it('blocks new risk from a restricted region but never closing, cancelling or withdrawing', async () => {
    const m = await fx.market();
    const t = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);

    const open = await postFrom(t.client, '/v1/orders', order(m.symbol), 'US');
    expect(open.status).toBe(451);
    expect(open.body.error.code).toBe('REGION_RESTRICTED');

    const batch = await postFrom(
      t.client,
      '/v1/orders/batch',
      { orders: [order(m.symbol, { reduceOnly: true }), order(m.symbol)] },
      'US',
    );
    expect(batch.status).toBe(451);

    // Reduce-only passes the gate (the order service then judges it on its merits).
    const reduce = await postFrom(
      t.client,
      '/v1/orders',
      order(m.symbol, { reduceOnly: true }),
      'US',
    );
    expect(reduce.body.error?.code).not.toBe('REGION_RESTRICTED');

    const cancelAll = await postFrom(t.client, '/v1/orders/cancel-all', {}, 'US');
    expect(cancelAll.status).toBe(202);

    const withdraw = await postFrom(
      t.client,
      '/v1/vault/withdrawals',
      { asset: m.quote, amount: '1' },
      'US',
    );
    expect(withdraw.body.error?.code).not.toBe('REGION_RESTRICTED');

    // The same account from an allowed region trades normally.
    expect((await postFrom(t.client, '/v1/orders', order(m.symbol), 'DE')).status).toBe(202);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'access.denied', actorUserId: t.userId },
    });
    expect(audit?.metadata).toMatchObject({ reason: 'REGION_RESTRICTED', country: 'US' });
  });

  it('opens no new account from a restricted region; existing accounts can still sign in', async () => {
    const w = wallet();
    const refused = await walletSignIn(w, 'KP');
    expect(refused.res.status).toBe(451);
    expect(refused.res.body.error.code).toBe('REGION_RESTRICTED');
    expect(
      await prisma.user.findUnique({ where: { walletAddress: w.address.toLowerCase() } }),
    ).toBeNull();

    expect((await walletSignIn(w, 'DE')).res.status).toBe(200);
    // Travelling later: signing in still works, so positions can be closed and funds withdrawn.
    expect((await walletSignIn(w, 'US')).res.status).toBe(200);
  });
});

describe('sanctions screening', () => {
  const source = `test-${randomBytes(4).toString('hex')}`;
  afterAll(async () => {
    await prisma.sanctionedAddress.deleteMany({ where: { source } });
  });

  it('refuses sign-in, trading and withdrawals for a listed wallet; cancels stay open', async () => {
    const w = wallet();
    const { client, res } = await walletSignIn(w);
    expect(res.status).toBe(200);
    const userId = res.body.user.id as string;
    const m = await fx.market();

    const r = await access.replaceSanctionsList(source, [w.address, 'not an address']);
    expect(r).toEqual({ added: 1, removed: 0, total: 1 });

    const again = await walletSignIn(w);
    expect(again.res.status).toBe(403);
    expect(again.res.body.error.code).toBe('SANCTIONED_ADDRESS');

    // An existing session is screened on every gated request.
    const placed = await client.post('/v1/orders', order(m.symbol));
    expect(placed.body.error.code).toBe('SANCTIONED_ADDRESS');
    const withdraw = await client.post('/v1/vault/withdrawals', { asset: m.quote, amount: '1' });
    expect(withdraw.body.error.code).toBe('SANCTIONED_ADDRESS');
    expect((await client.post('/v1/orders/cancel-all', {})).status).toBe(202);
    expect((await client.get('/v1/me/access')).body.sanctioned).toBe(true);

    // Sub-accounts answer for their parent's wallet.
    expect((await client.post('/v1/me/sub-accounts', { label: 'desk' })).body.error.code).toBe(
      'SANCTIONED_ADDRESS',
    );

    // Replacing the list with one that no longer contains the address lifts the block.
    const other = wallet();
    expect(await access.replaceSanctionsList(source, [other.address])).toEqual({
      added: 1,
      removed: 1,
      total: 1,
    });
    expect((await walletSignIn(w)).res.status).toBe(200);
    expect(await access.isSanctioned(other.address)).toBe(true);

    const audits = await prisma.auditLog.count({
      where: { action: 'access.sanctions.list_replaced', targetId: source },
    });
    expect(audits).toBe(2);
    expect(userId).toBeTruthy();
  });
});

describe('OFAC SDN list sync', () => {
  afterAll(async () => {
    await prisma.sanctionedAddress.deleteMany({ where: { source: OFAC_SOURCE } });
  });

  it('loads EVM addresses from the SDN format and refuses a broken update', async () => {
    const sync = app.get(SanctionsSyncService);
    const listed = [wallet(), wallet(), wallet()];
    // Synthetic rows in the SDN.CSV format: the test never downloads the real list.
    const row = (n: number, ticker: string, address: string) =>
      `${n},"TEST ENTRY ${n}","-0- ","CYBER2",-0- ,"Digital Currency Address - ${ticker} ${address}; Digital Currency Address - XBT 1BoatSLRHtKNngkdXEeobR76b53LETtpyT."`;
    const csv = listed.map((w, i) => row(i + 1, i === 1 ? 'USDT' : 'ETH', w.address)).join('\n');

    expect(await sync.syncOfac({ text: csv })).toEqual({
      source: OFAC_SOURCE,
      added: 3,
      removed: 0,
      total: 3,
    });
    expect((await walletSignIn(listed[1]!)).res.body.error.code).toBe('SANCTIONED_ADDRESS');

    // An empty or sharply shrunk download keeps the previous list.
    await expect(sync.syncOfac({ text: 'not the list' })).rejects.toThrow(/no EVM addresses/);
    await expect(sync.syncOfac({ text: row(9, 'ETH', listed[0]!.address) })).rejects.toThrow(
      /less than half/,
    );
    expect(await access.isSanctioned(listed[2]!.address)).toBe(true);
    // An operator can force a genuine shrink.
    expect(
      (await sync.syncOfac({ text: row(9, 'ETH', listed[0]!.address), force: true })).total,
    ).toBe(1);
  });
});
