import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ChainService } from '../src/chain/chain.service';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { ReconciliationService } from '../src/ledger/reconciliation.service';
import { MarketsService } from '../src/trading/markets.service';
import { TestClient, bootApp, createVerifiedUser } from './helpers';
import { SYSTEM } from './trading-helpers';

/**
 * Runs against the local Anvil chain (docker compose up -d chain) on
 * TEST_CHAIN_RPC_URL (default http://localhost:8545). Skipped when unreachable.
 */
const RPC = process.env.TEST_CHAIN_RPC_URL ?? 'http://localhost:8545';
const VAULT_ABI = parseAbi([
  'function deposit(address token, uint256 amount) returns (uint64)',
  'function withdraw((bytes32 id, address user, address token, uint256 amount, uint64 afterState, uint64 expiry) w, bytes signature)',
  'function freeze()',
  'function escape(address token, uint256 balance, bytes32[] proof)',
  'function escapeDeposit(uint64 depositId)',
  'function stateIndex() view returns (uint64)',
]);
const TOKEN_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

let app: INestApplication;
let prisma: PrismaService;
let chain: ChainService;
let ledger: LedgerService;
let client: PublicClient;
let reachable = false;
const saved: Record<string, string | undefined> = {};

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return ((await res.json()) as { result: unknown }).result;
}

async function signInWallet(key: Hex): Promise<{ http: TestClient; userId: string }> {
  const account = privateKeyToAccount(key);
  const http_ = new TestClient(app);
  const n = (await http_.get('/v1/auth/wallet/nonce')).body as {
    nonce: string;
    domain: string;
    uri: string;
  };
  const message = [
    `${n.domain} wants you to sign in with your Ethereum account:`,
    account.address,
    '',
    'Sign in.',
    '',
    `URI: ${n.uri}`,
    'Version: 1',
    'Chain ID: 31337',
    `Nonce: ${n.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n');
  const signature = await account.signMessage({ message });
  const res = await http_.post('/v1/auth/wallet/login', { message, signature });
  expect(res.status).toBe(200);
  return { http: http_, userId: res.body.user.id as string };
}

async function balance(userId: string, asset: string) {
  return (await ledger.balancesForUser(userId)).find((b) => b.asset === asset);
}

beforeAll(async () => {
  reachable = (await rpc('eth_chainId').catch(() => null)) === '0x7a69';
  if (!reachable && process.env.TEST_CHAIN_REQUIRED)
    throw new Error(`TEST_CHAIN_REQUIRED is set but no local chain answers at ${RPC}`);
  if (!reachable) return;
  const env = {
    CHAIN_RPC_URL: RPC,
    CHAIN_OPERATOR_KEY: generatePrivateKey(),
    CHAIN_CONFIRMATIONS: '0',
    CHAIN_POLL_MS: '0',
    VAULT_STATE_INTERVAL_SECONDS: '0',
    VAULT_WITHDRAWAL_TTL_SECONDS: '60',
    CHAIN_FAUCET_ENABLED: 'true',
  };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  app = await bootApp();
  prisma = app.get(PrismaService);
  chain = app.get(ChainService);
  ledger = app.get(LedgerService);
  client = createPublicClient({ transport: http(RPC) });
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const it_ = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
  it(
    name,
    async () => {
      if (!reachable) {
        // Skipped locally without a chain; CI sets TEST_CHAIN_REQUIRED (see beforeAll).
        return;
      }
      await fn();
    },
    timeout,
  );

describe('non-custodial vault on the local chain', () => {
  it_(
    'deposits, withdrawals, state roots and the escape hatch stay consistent with the ledger',
    async () => {
      const suffix = randomBytes(3).toString('hex').toUpperCase();
      const [USD, BTC] = [`TU${suffix}`, `TB${suffix}`];
      const { vault, tokens } = await chain.deploy({
        tokens: [
          { code: USD, name: 'Test USD', decimals: 6, faucetLimit: 10n ** 15n },
          { code: BTC, name: 'Test BTC', decimals: 8, faucetLimit: 10n ** 12n },
        ],
        freezeDelaySeconds: 3600,
      });
      const usd = tokens[USD]!;
      const key = generatePrivateKey();
      const me = privateKeyToAccount(key);
      const user = await signInWallet(key);
      expect((await user.http.post('/v1/vault/faucet', {})).status).toBe(200);
      const wallet = createWalletClient({ account: me, transport: http(RPC) });
      const write = async (address: Hex, abi: never, functionName: string, args: unknown[]) => {
        const hash = await wallet.writeContract({
          address,
          abi,
          functionName: functionName,
          args: args,
          chain: null,
        });
        const r = await client.waitForTransactionReceipt({ hash });
        expect(r.status).toBe('success');
      };

      // Deposit 500 TUSD and index it (twice: idempotent).
      await write(usd, TOKEN_ABI as never, 'approve', [vault, 2n ** 255n]);
      await write(vault, VAULT_ABI as never, 'deposit', [usd, 500_000_000n]);
      expect(await chain.indexOnce()).toBe(1);
      await chain.indexOnce();
      expect((await balance(user.userId, USD))?.available).toBe('500.000000');

      // Withdraw 200: hold, sign, execute from the wallet, finalise from the event.
      const w = await user.http.post('/v1/vault/withdrawals', { asset: USD, amount: '200' });
      expect(w.status).toBe(201);
      expect((await balance(user.userId, USD))?.available).toBe('300.000000');
      const call = w.body.call;
      const args = [
        {
          id: call.withdrawal.id,
          user: call.withdrawal.user,
          token: call.withdrawal.token,
          amount: BigInt(call.withdrawal.amount),
          afterState: BigInt(call.withdrawal.afterState),
          expiry: BigInt(call.withdrawal.expiry),
        },
        call.signature,
      ];
      await write(vault, VAULT_ABI as never, 'withdraw', args);
      await chain.indexOnce();
      expect((await user.http.get('/v1/vault/withdrawals')).body.withdrawals[0].status).toBe(
        'executed',
      );
      expect(
        (await client.readContract({
          address: usd,
          abi: TOKEN_ABI,
          functionName: 'balanceOf',
          args: [me.address],
        })) %
          10n ** 6n,
      ).toBe(0n);
      expect((await chain.custodyCheck()).filter((c) => !c.ok)).toEqual([]);

      // An unexecuted withdrawal expires only after indexed chain time passes its expiry.
      const stale = await user.http.post('/v1/vault/withdrawals', { asset: USD, amount: '50' });
      expect((await balance(user.userId, USD))?.available).toBe('250.000000');
      await rpc('evm_increaseTime', [120]);
      await rpc('evm_mine');
      await chain.indexOnce();
      expect(await chain.expireWithdrawals()).toBe(1);
      expect((await balance(user.userId, USD))?.available).toBe('300.000000');
      const staleCall = stale.body.call;
      await expect(
        wallet.writeContract({
          address: vault,
          abi: VAULT_ABI,
          functionName: 'withdraw',
          args: [
            {
              id: staleCall.withdrawal.id,
              user: staleCall.withdrawal.user,
              token: staleCall.withdrawal.token,
              amount: BigInt(staleCall.withdrawal.amount),
              afterState: BigInt(staleCall.withdrawal.afterState),
              expiry: BigInt(staleCall.withdrawal.expiry),
            },
            staleCall.signature,
          ],
          chain: null,
        }),
      ).rejects.toThrow();

      // Commit a balance root; the user's proof matches the committed balance.
      expect(await chain.commitState()).toBe(1n);
      expect(
        await client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'stateIndex' }),
      ).toBe(1n);
      const proof = (await user.http.get('/v1/vault/proof')).body;
      expect(proof).toMatchObject({ stateIndex: '1', lastDepositId: '1' });
      expect(proof.entries[0]).toMatchObject({ asset: USD, balance: '300000000' });

      // After the snapshot: withdraw 30 (signed against state 1), deposit 20 more.
      const w2 = (await user.http.post('/v1/vault/withdrawals', { asset: USD, amount: '30' })).body;
      expect(w2.call.withdrawal.afterState).toBe('1');
      await write(vault, VAULT_ABI as never, 'withdraw', [
        {
          id: w2.call.withdrawal.id,
          user: w2.call.withdrawal.user,
          token: w2.call.withdrawal.token,
          amount: BigInt(w2.call.withdrawal.amount),
          afterState: 1n,
          expiry: BigInt(w2.call.withdrawal.expiry),
        },
        w2.call.signature,
      ]);
      await write(vault, VAULT_ABI as never, 'deposit', [usd, 20_000_000n]);
      await chain.indexOnce();
      expect((await chain.custodyCheck()).filter((c) => !c.ok)).toEqual([]);

      // The operator goes silent: anyone freezes, the user leaves with proof + late deposit.
      await rpc('evm_increaseTime', [3601]);
      await rpc('evm_mine');
      await write(vault, VAULT_ABI as never, 'freeze', []);
      const before = await client.readContract({
        address: usd,
        abi: TOKEN_ABI,
        functionName: 'balanceOf',
        args: [me.address],
      });
      await write(vault, VAULT_ABI as never, 'escape', [usd, 300_000_000n, proof.entries[0].proof]);
      await write(vault, VAULT_ABI as never, 'escapeDeposit', [2n]);
      const after = await client.readContract({
        address: usd,
        abi: TOKEN_ABI,
        functionName: 'balanceOf',
        args: [me.address],
      });
      // 300 committed − 30 withdrawn after the snapshot + 20 deposited after it.
      expect(after - before).toBe(290_000_000n);
      expect(
        await client.readContract({
          address: usd,
          abi: TOKEN_ABI,
          functionName: 'balanceOf',
          args: [vault],
        }),
      ).toBe(0n);

      const run = await app.get(ReconciliationService).run('CLI');
      expect(run.findings).toEqual([]);
    },
  );

  it_('vault-backed markets are for wallet accounts only', async () => {
    const suffix = randomBytes(3).toString('hex').toUpperCase();
    const [base, quote] = [`WB${suffix}`, `WQ${suffix}`];
    for (const [code, scale] of [
      [base, 8],
      [quote, 6],
    ] as const) {
      await ledger.createAsset({ code, name: code, scale }, SYSTEM);
      await prisma.asset.update({
        where: { code },
        data: { chainTokenAddress: `0x${randomBytes(20).toString('hex')}` },
      });
    }
    const market = await app
      .get(MarketsService)
      .create(
        { base, quote, tickSize: '0.01', lotSize: '0.0001', makerFeeBps: 0, takerFeeBps: 0 },
        SYSTEM,
      );
    const emailUser = await createVerifiedUser(app);
    const res = await emailUser.post('/v1/orders', {
      market: market.symbol,
      clientOrderId: 'vault-mkt-1',
      side: 'buy',
      type: 'limit',
      price: '1',
      quantity: '1',
    });
    expect(res.status).toBe(403);
  });

  it_('a leader vault is claimable by its share holders, never by the leader alone', async () => {
    const sfx = randomBytes(3).toString('hex').toUpperCase();
    const usd = `LV${sfx}`;
    const { vault, tokens } = await chain.deploy({
      tokens: [{ code: usd, name: 'Vault USD', decimals: 6, faucetLimit: 10n ** 15n }],
      freezeDelaySeconds: 3600,
    });
    const token = tokens[usd]!;
    const keys = [generatePrivateKey(), generatePrivateKey()] as const;
    const users = [];
    for (const key of keys) {
      const u = await signInWallet(key);
      expect((await u.http.post('/v1/vault/faucet', {})).status).toBe(200);
      const wallet = createWalletClient({
        account: privateKeyToAccount(key),
        transport: http(RPC),
      });
      for (const [address, abi, fn, args] of [
        [token, TOKEN_ABI, 'approve', [vault, 2n ** 255n]],
        [vault, VAULT_ABI, 'deposit', [token, 400_000_000n]],
      ] as const) {
        const hash = await wallet.writeContract({
          address,
          abi: abi as never,
          functionName: fn,
          args: args,
          chain: null,
        });
        await client.waitForTransactionReceipt({ hash });
      }
      users.push({ ...u, address: privateKeyToAccount(key).address.toLowerCase() });
    }
    await chain.indexOnce();
    const [leader, follower] = users as [(typeof users)[0], (typeof users)[0]];
    const created = await leader.http.post('/v1/leader-vaults', {
      name: `Chain ${sfx}`,
      asset: usd,
      profitShareBps: 1000,
      maxLeverage: 5,
      maxDrawdownBps: 5000,
      initialDeposit: '100',
    });
    expect(created.status).toBe(201);
    const dep = await follower.http.post(`/v1/leader-vaults/${created.body.id}/deposit`, {
      amount: '300',
      idempotencyKey: 'chain-dep-01',
    });
    expect(dep.status).toBe(200);
    expect(await chain.commitState()).toBe(1n);
    const leaves = await prisma.vaultStateLeaf.findMany({
      where: { vaultAddress: vault.toLowerCase(), index: 1n },
    });
    const of = (w: string) => leaves.find((l) => l.walletAddress === w)?.balance.toString();
    // Each keeps own balance plus its share of the vault: leader 300 + 100, follower 100 + 300.
    expect(of(leader.address)).toBe('400000000');
    expect(of(follower.address)).toBe('400000000');
    expect(leaves).toHaveLength(2);
    // Public proof of liabilities: the contract holds what the root promises.
    const solvency = (await new TestClient(app).get('/v1/vault/solvency')).body;
    expect(solvency.state).toMatchObject({ index: '1', leafCount: 2 });
    expect(solvency.tokens).toEqual([
      expect.objectContaining({
        asset: usd,
        onChainBalance: '800',
        committedLiabilities: '800',
        ledgerMatchesChain: true,
        committedCovered: true,
      }),
    ]);
  });
});
