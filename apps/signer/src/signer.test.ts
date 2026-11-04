import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { signRequest, verifyRequest } from './hmac';
import { type PolicyError, SigningPolicy } from './policy';
import { createSignerServer, type SignerConfig } from './server';

const VAULT = '0x' + 'aa'.repeat(20);
const TOKEN = '0x' + 'bb'.repeat(20);
const SECRET = 's'.repeat(40);
const NOW = new Date('2026-11-04T10:00:00Z');
const nowS = Math.floor(NOW.getTime() / 1000);

function config(dir: string, key: Hex): SignerConfig {
  return {
    operatorKey: key,
    hmacSecret: SECRET,
    rpcUrl: 'http://127.0.0.1:1', // unused by withdrawal signing
    policy: {
      chainId: 31337,
      vault: VAULT,
      limits: new Map([[TOKEN, { perTx: 1_000n, daily: 2_500n }]]),
      maxTtlSeconds: 3600,
    },
    auditFile: join(dir, 'audit.jsonl'),
    minCommitIntervalSeconds: 0,
    chainTime: () => Promise.resolve(BigInt(nowS)),
  };
}

function withdrawal(id: number, amount: number, expiry = nowS + 600) {
  return {
    chainId: 31337,
    vault: VAULT,
    withdrawal: {
      id: `0x${id.toString(16).padStart(64, '0')}`,
      user: '0x' + 'cc'.repeat(20),
      token: TOKEN,
      amount: String(amount),
      afterState: '0',
      expiry: String(expiry),
    },
  };
}

const servers: { close(): void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function start(cfg: SignerConfig) {
  const server = createSignerServer(cfg, () => NOW);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  let n = 0;
  return async (
    path: string,
    body: unknown,
    opts: { secret?: string; requestId?: string; ts?: number } = {},
  ) => {
    const text = JSON.stringify(body);
    const ts = String(opts.ts ?? NOW.getTime());
    const requestId = opts.requestId ?? `req-${++n}-${Math.random()}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signer-timestamp': ts,
        'x-signer-request-id': requestId,
        'x-signer-signature': signRequest(opts.secret ?? SECRET, ts, requestId, text),
      },
      body: text,
    });
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  };
}

describe('HMAC request authentication', () => {
  it('accepts fresh, correctly signed requests only', () => {
    const sig = signRequest(SECRET, String(NOW.getTime()), 'r1', '{}');
    const h = { timestamp: String(NOW.getTime()), requestId: 'r1', signature: sig };
    expect(verifyRequest(SECRET, h, '{}', NOW)).toBe('ok');
    expect(verifyRequest(SECRET, h, '{"x":1}', NOW)).toBe('bad_signature');
    expect(verifyRequest('x'.repeat(40), h, '{}', NOW)).toBe('bad_signature');
    expect(verifyRequest(SECRET, h, '{}', new Date(NOW.getTime() + 60_000))).toBe('stale');
    expect(verifyRequest(SECRET, {}, '{}', NOW)).toBe('missing');
  });
});

describe('signing policy', () => {
  const p = () =>
    new SigningPolicy({
      chainId: 1,
      vault: VAULT,
      limits: new Map([[TOKEN, { perTx: 10n, daily: 15n }]]),
      maxTtlSeconds: 60,
    });
  const req = (over = {}) => ({
    chainId: 1,
    vault: VAULT,
    id: '0x01',
    user: '0x' + 'cc'.repeat(20),
    token: TOKEN,
    amount: 5n,
    afterState: 0n,
    expiry: BigInt(nowS + 30),
    ...over,
  });
  const code = (fn: () => void) => {
    try {
      fn();
      return 'ok';
    } catch (e) {
      return (e as PolicyError).code;
    }
  };

  it('enforces chain, vault, token, amount, expiry, uniqueness and daily totals', () => {
    const policy = p();
    expect(code(() => policy.check(req({ chainId: 2 }), NOW))).toBe('WRONG_CHAIN');
    expect(code(() => policy.check(req({ vault: '0x' + '11'.repeat(20) }), NOW))).toBe(
      'WRONG_VAULT',
    );
    expect(code(() => policy.check(req({ token: '0x' + '22'.repeat(20) }), NOW))).toBe(
      'TOKEN_NOT_ALLOWED',
    );
    expect(code(() => policy.check(req({ amount: 11n }), NOW))).toBe('PER_TX_LIMIT');
    expect(code(() => policy.check(req({ expiry: BigInt(nowS + 3600) }), NOW))).toBe('BAD_EXPIRY');
    expect(code(() => policy.check(req({ expiry: BigInt(nowS - 1) }), NOW))).toBe('BAD_EXPIRY');
    policy.record(req({ id: '0x01', amount: 10n }), NOW);
    expect(code(() => policy.check(req({ id: '0x01' }), NOW))).toBe('DUPLICATE_ID');
    expect(code(() => policy.check(req({ id: '0x02', amount: 6n }), NOW))).toBe('DAILY_LIMIT');
    expect(code(() => policy.check(req({ id: '0x02', amount: 5n }), NOW))).toBe('ok');
    // A new UTC day resets the daily total.
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    expect(
      code(() =>
        policy.check(
          req({ id: '0x03', amount: 10n, expiry: BigInt(nowS + 86_400 + 30) }),
          tomorrow,
        ),
      ),
    ).toBe('ok');
  });
});

describe('signer service', () => {
  it('signs valid withdrawals with the operator key and refuses the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signer-'));
    const key = generatePrivateKey();
    const call = await start(config(dir, key));

    const ok = await call('/v1/sign/withdrawal', withdrawal(1, 1000));
    expect(ok.status).toBe(200);
    const w = withdrawal(1, 1000).withdrawal;
    const signer = await recoverTypedDataAddress({
      domain: {
        name: 'ExchangeVault',
        version: '1',
        chainId: 31337,
        verifyingContract: getAddress(VAULT),
      },
      types: {
        Withdrawal: [
          { name: 'id', type: 'bytes32' },
          { name: 'user', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'afterState', type: 'uint64' },
          { name: 'expiry', type: 'uint64' },
        ],
      },
      primaryType: 'Withdrawal',
      message: {
        id: w.id as Hex,
        user: getAddress(w.user),
        token: getAddress(w.token),
        amount: 1000n,
        afterState: 0n,
        expiry: BigInt(w.expiry),
      },
      signature: ok.body.signature as Hex,
    });
    expect(signer).toBe(privateKeyToAccount(key).address);

    expect((await call('/v1/sign/withdrawal', withdrawal(1, 10))).body.error).toBe('DUPLICATE_ID');
    expect((await call('/v1/sign/withdrawal', withdrawal(2, 1001))).body.error).toBe(
      'PER_TX_LIMIT',
    );
    expect((await call('/v1/sign/withdrawal', withdrawal(3, 1000))).status).toBe(200);
    expect((await call('/v1/sign/withdrawal', withdrawal(4, 600))).body.error).toBe('DAILY_LIMIT');
    expect(
      (await call('/v1/sign/withdrawal', withdrawal(5, 1), { secret: 'w'.repeat(40) })).status,
    ).toBe(401);
    const replayed = await call('/v1/sign/withdrawal', withdrawal(6, 1), { requestId: 'fixed' });
    expect(replayed.status).toBe(200);
    expect(
      (await call('/v1/sign/withdrawal', withdrawal(7, 1), { requestId: 'fixed' })).status,
    ).toBe(401);
    expect((await call('/v1/anything', {})).status).toBe(404);

    const log = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    expect(log).toContain('"kind":"withdrawal.refused"');
    expect(log).toContain('"kind":"auth.rejected"');
  });

  it('keeps daily limits and used ids across a restart (rebuilt from the audit log)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signer-'));
    const key = generatePrivateKey();
    const first = await start(config(dir, key));
    expect((await first('/v1/sign/withdrawal', withdrawal(10, 1000))).status).toBe(200);
    expect((await first('/v1/sign/withdrawal', withdrawal(11, 1000))).status).toBe(200);
    servers.splice(0).forEach((s) => s.close());

    const second = await start(config(dir, key));
    expect((await second('/v1/sign/withdrawal', withdrawal(10, 1))).body.error).toBe(
      'DUPLICATE_ID',
    );
    expect((await second('/v1/sign/withdrawal', withdrawal(12, 501))).body.error).toBe(
      'DAILY_LIMIT',
    );
    expect((await second('/v1/sign/withdrawal', withdrawal(12, 500))).status).toBe(200);
  });
});
