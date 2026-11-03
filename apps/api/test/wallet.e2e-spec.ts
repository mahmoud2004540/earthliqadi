import type { INestApplication } from '@nestjs/common';
import { secp256k1 } from '@noble/curves/secp256k1';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { addressFromPublicKey, personalMessageHash, toChecksumAddress } from '../src/auth/siwe';
import { TestClient, bootApp } from './helpers';

let app: INestApplication;
let prisma: PrismaService;

function wallet() {
  const key = secp256k1.utils.randomPrivateKey();
  const address = toChecksumAddress(addressFromPublicKey(secp256k1.getPublicKey(key, false)));
  const sign = (message: string) => {
    const sig = secp256k1.sign(personalMessageHash(message), key);
    return `0x${Buffer.from(sig.toCompactRawBytes()).toString('hex')}${(27 + sig.recovery).toString(16)}`;
  };
  return { address, sign };
}

function siwe(
  address: string,
  n: { nonce: string; domain: string; uri: string },
  overrides: { domain?: string } = {},
): string {
  return [
    `${overrides.domain ?? n.domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Sign in to the exchange.',
    '',
    `URI: ${n.uri}`,
    'Version: 1',
    'Chain ID: 1',
    `Nonce: ${n.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n');
}

async function signIn(client: TestClient, w: ReturnType<typeof wallet>, overrides = {}) {
  const n = (await client.get('/v1/auth/wallet/nonce')).body as {
    nonce: string;
    domain: string;
    uri: string;
  };
  const message = siwe(w.address, n, overrides);
  const signature = w.sign(message);
  const res = await client.post('/v1/auth/wallet/login', { message, signature });
  return { res, message, signature };
}

beforeAll(async () => {
  app = await bootApp();
  prisma = app.get(PrismaService);
}, 60_000);

afterAll(async () => {
  await app.close();
});

describe('Sign-In with Ethereum (no email, no password, no KYC)', () => {
  it('creates the account on first signature and signs the same wallet back in', async () => {
    const w = wallet();
    const client = new TestClient(app);
    const { res } = await signIn(client, w);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'authenticated',
      user: { walletAddress: w.address, email: null, status: 'ACTIVE' },
    });
    expect(res.body.user.permissions).toContain('trading:trade');
    const me = await client.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.walletAddress).toBe(w.address);

    const again = await signIn(new TestClient(app), w);
    expect(again.res.body.user.id).toBe(res.body.user.id);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: res.body.user.id as string } });
    expect(row).toMatchObject({
      email: null,
      passwordHash: null,
      walletAddress: w.address.toLowerCase(),
    });
  });

  it('rejects replays, foreign domains, unknown nonces and forged signatures', async () => {
    const w = wallet();
    const client = new TestClient(app);
    const first = await signIn(client, w);
    expect(first.res.status).toBe(200);
    // The nonce is single use.
    const replay = await new TestClient(app).post('/v1/auth/wallet/login', {
      message: first.message,
      signature: first.signature,
    });
    expect(replay.status).toBe(401);

    expect((await signIn(new TestClient(app), w, { domain: 'evil.example' })).res.status).toBe(401);

    const made = siwe(w.address, {
      nonce: 'neverissued12345',
      domain: 'localhost:3000',
      uri: 'http://localhost:3000',
    });
    const unknown = await new TestClient(app).post('/v1/auth/wallet/login', {
      message: made,
      signature: w.sign(made),
    });
    expect(unknown.status).toBe(401);

    const n = (await client.get('/v1/auth/wallet/nonce')).body;
    const forged = siwe(w.address, n);
    const attacker = wallet();
    expect(
      (
        await new TestClient(app).post('/v1/auth/wallet/login', {
          message: forged,
          signature: attacker.sign(forged),
        })
      ).status,
    ).toBe(401);
  });

  it('has no password or authenticator setup, and suspended wallets cannot sign in', async () => {
    const w = wallet();
    const client = new TestClient(app);
    const { res } = await signIn(client, w);
    expect(
      (
        await client.post('/v1/me/password', {
          currentPassword: 'x'.repeat(12),
          newPassword: 'y'.repeat(14),
        })
      ).status,
    ).not.toBe(200);
    expect(
      (await client.post('/v1/me/mfa/totp/setup', { password: 'whatever-password' })).status,
    ).toBe(409);
    await prisma.user.update({
      where: { id: res.body.user.id as string },
      data: { status: 'SUSPENDED' },
    });
    expect((await signIn(new TestClient(app), w)).res.status).toBe(403);
  });

  it('enforces the database identity rules', async () => {
    const w = wallet();
    const { res } = await signIn(new TestClient(app), w);
    const id = res.body.user.id as string;
    await expect(
      prisma.user.update({ where: { id }, data: { walletAddress: '0x'.padEnd(42, 'a') } }),
    ).rejects.toThrow(/immutable/);
    await expect(prisma.user.create({ data: { status: 'ACTIVE' } })).rejects.toThrow(
      /users_credential_chk/,
    );
  });
});
