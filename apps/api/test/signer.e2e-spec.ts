import type { INestApplication } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ChainService } from '../src/chain/chain.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { TestClient, bootApp } from './helpers';

/**
 * The API with the ISOLATED signer service (ADR-0015) against the local chain:
 * withdrawals and state commits go through the signer, whose own limits hold
 * even though the API asks. Skipped when no local chain is reachable (required in CI).
 */
const RPC = process.env.TEST_CHAIN_RPC_URL ?? 'http://localhost:8545';
const VAULT_ABI = parseAbi([
  'function deposit(address token, uint256 amount) returns (uint64)',
  'function withdraw((bytes32 id, address user, address token, uint256 amount, uint64 afterState, uint64 expiry) w, bytes signature)',
  'function stateIndex() view returns (uint64)',
]);
const TOKEN_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const SECRET = randomBytes(24).toString('hex');
const OPERATOR = generatePrivateKey();

let deployer: INestApplication | null = null;
let app: INestApplication | null = null;
let signer: ChildProcess | null = null;
let reachable = false;
const saved: Record<string, string | undefined> = {};

function setEnv(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
}

beforeAll(async () => {
  const id = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  })
    .then((r) => r.json() as Promise<{ result: string }>)
    .catch(() => null);
  reachable = id?.result === '0x7a69';
  if (!reachable && process.env.TEST_CHAIN_REQUIRED)
    throw new Error(`TEST_CHAIN_REQUIRED is set but no local chain answers at ${RPC}`);
}, 30_000);

afterAll(async () => {
  signer?.kill();
  await app?.close();
  await deployer?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

it('withdrawals and state commits go through the isolated signer and its limits', async () => {
  if (!reachable) return;
  setEnv({
    CHAIN_RPC_URL: RPC,
    CHAIN_OPERATOR_KEY: OPERATOR,
    CHAIN_CONFIRMATIONS: '0',
    CHAIN_POLL_MS: '0',
    VAULT_STATE_INTERVAL_SECONDS: '0',
    CHAIN_FAUCET_ENABLED: 'true',
  });
  // 1. Deploy with the local key (deployment is an operator task, out of band).
  deployer = await bootApp();
  const sfx = randomBytes(3).toString('hex').toUpperCase();
  const usdCode = `SU${sfx}`;
  const { vault, tokens } = await deployer.get(ChainService).deploy({
    tokens: [{ code: usdCode, name: 'Signer USD', decimals: 6, faucetLimit: 10n ** 15n }],
    freezeDelaySeconds: 3600,
  });
  const usd = tokens[usdCode]!;
  await deployer.close();
  deployer = null;

  // 2. Start the signer with its own policy: 100 per withdrawal, 150 per day.
  const dir = mkdtempSync(join(tmpdir(), 'signer-'));
  signer = spawn(process.execPath, [resolve(__dirname, '../../signer/dist/main.js')], {
    env: {
      ...process.env,
      SIGNER_OPERATOR_KEY: OPERATOR,
      SIGNER_HMAC_SECRET: SECRET,
      SIGNER_RPC_URL: RPC,
      SIGNER_CHAIN_ID: '31337',
      SIGNER_VAULT_ADDRESS: vault,
      SIGNER_LIMITS: JSON.stringify({ [usd]: { perTx: '100000000', daily: '150000000' } }),
      SIGNER_MIN_COMMIT_INTERVAL_SECONDS: '0',
      SIGNER_AUDIT_FILE: join(dir, 'audit.jsonl'),
      PORT: '4199',
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((ok, fail) => {
    signer!.stdout!.on('data', (b: Buffer) => b.toString().includes('listening') && ok());
    signer!.on('exit', (c) => fail(new Error(`signer exited ${c}`)));
  });

  // 3. The API in remote-signer mode (the local key is only kept here for the test faucet).
  setEnv({ SIGNER_URL: 'http://127.0.0.1:4199', SIGNER_HMAC_SECRET: SECRET });
  app = await bootApp();
  const chain = app.get(ChainService);
  const ledger = app.get(LedgerService);

  const key = generatePrivateKey();
  const me = privateKeyToAccount(key);
  const client = new TestClient(app);
  const n = (await client.get('/v1/auth/wallet/nonce')).body as {
    nonce: string;
    domain: string;
    uri: string;
  };
  const message = [
    `${n.domain} wants you to sign in with your Ethereum account:`,
    me.address,
    '',
    'Sign in.',
    '',
    `URI: ${n.uri}`,
    'Version: 1',
    'Chain ID: 31337',
    `Nonce: ${n.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n');
  const login = await client.post('/v1/auth/wallet/login', {
    message,
    signature: await me.signMessage({ message }),
  });
  const userId = login.body.user.id as string;
  expect((await client.post('/v1/vault/faucet', {})).status).toBe(200);

  const pub = createPublicClient({ transport: http(RPC), cacheTime: 0 });
  const wallet = createWalletClient({ account: me, transport: http(RPC) });
  const send = async (address: Hex, abi: never, functionName: string, args: unknown[]) => {
    const hash = await wallet.writeContract({
      address,
      abi,
      functionName: functionName,
      args: args,
      chain: null,
    });
    expect((await pub.waitForTransactionReceipt({ hash })).status).toBe('success');
  };
  await send(usd, TOKEN_ABI as never, 'approve', [vault, 2n ** 255n]);
  await send(vault, VAULT_ABI as never, 'deposit', [usd, 300_000_000n]);
  await chain.indexOnce();
  const available = async () =>
    (await ledger.balancesForUser(userId)).find((b) => b.asset === usdCode)?.available;
  expect(await available()).toBe('300.000000');

  // Within limits: signed by the signer, valid on-chain.
  const ok = await client.post('/v1/vault/withdrawals', { asset: usdCode, amount: '100' });
  expect(ok.status).toBe(201);
  const c = ok.body.call;
  await send(vault, VAULT_ABI as never, 'withdraw', [
    {
      id: c.withdrawal.id,
      user: c.withdrawal.user,
      token: c.withdrawal.token,
      amount: BigInt(c.withdrawal.amount),
      afterState: BigInt(c.withdrawal.afterState),
      expiry: BigInt(c.withdrawal.expiry),
    },
    c.signature,
  ]);

  // Over the per-withdrawal or the daily limit: refused by the SIGNER, and the hold rolls back.
  const tooBig = await client.post('/v1/vault/withdrawals', { asset: usdCode, amount: '101' });
  expect(tooBig.status).toBe(409);
  expect(tooBig.body.error.code).toBe('LIMIT_EXCEEDED');
  const daily = await client.post('/v1/vault/withdrawals', { asset: usdCode, amount: '60' });
  expect(daily.status).toBe(409);
  expect(await available()).toBe('200.000000');

  // State commits are sent by the signer.
  expect(await chain.commitState()).toBe(1n);
  expect(
    await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: 'stateIndex' }),
  ).toBe(1n);

  const log = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
  expect(log).toContain('"kind":"withdrawal.signed"');
  expect(log).toContain('"code":"PER_TX_LIMIT"');
  expect(log).toContain('"code":"DAILY_LIMIT"');
  expect(log).toContain('"kind":"state.committed"');
}, 180_000);
