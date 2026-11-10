/**
 * Real-value mode (ADR-0038) against a local FORK of Base mainnet: the real
 * USDC contract, chain id 8453, no real funds (balances are set on the fork).
 * Runs when TEST_BASE_FORK_RPC points at `anvil --fork-url https://mainnet.base.org`.
 */
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { MAINNET_NETWORKS } from '@platform/shared';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../src/bootstrap';
import { ChainService } from '../src/chain/chain.service';
import { loadAppConfig } from '../src/config/app-config';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { TestClient } from './helpers';

const RPC = process.env.TEST_BASE_FORK_RPC;
const USDC = MAINNET_NETWORKS[0]!.usdc as Hex;
const ERC20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const VAULT = parseAbi([
  'function deposit(address token, uint256 amount) returns (uint64)',
  'function depositCap(address) view returns (uint256)',
  'function withdraw((bytes32 id, address user, address token, uint256 amount, uint64 afterState, uint64 expiry) w, bytes signature)',
]);

let app: INestApplication;
let chain: ChainService;
const saved: Record<string, string | undefined> = {};
const operatorKey = generatePrivateKey();
const run = RPC ? describe : describe.skip;

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return ((await res.json()) as { result: unknown }).result;
}

/** USDC (FiatToken) keeps balances in storage slot 9. */
async function giveUsdc(to: Hex, amount: bigint) {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [to, 9n]));
  await rpc('anvil_setStorageAt', [USDC, slot, pad(toHex(amount))]);
}

run('real-value mode on a Base mainnet fork (ADR-0038)', () => {
  beforeAll(async () => {
    const env = {
      CHAIN_RPC_URL: RPC!,
      CHAIN_OPERATOR_KEY: operatorKey,
      CHAIN_CONFIRMATIONS: '0',
      CHAIN_POLL_MS: '0',
      VAULT_STATE_INTERVAL_SECONDS: '0',
    };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    if (!process.env.TEST_LOGS) Logger.overrideLogger(false);
    // Production-only by configuration; the service behaviour is tested here directly.
    app = await createApp({ ...loadAppConfig(), CHAIN_MAINNET: true });
    await app.init();
    chain = app.get(ChainService);
    await rpc('anvil_setBalance', [privateKeyToAccount(operatorKey).address, toHex(10n ** 18n)]);
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('deploys only with the real USDC and a finite cap, and works end to end', async () => {
    const client = createPublicClient({ transport: http(RPC) });
    // The token's permanent asset code (a reused test database may already have one).
    const linked = await app
      .get(PrismaService)
      .asset.findFirst({ where: { chainTokenAddress: USDC.toLowerCase() } });
    const CODE = linked?.code ?? 'USDC';
    expect(await chain.chainId()).toBe(8453);
    const base = { freezeDelaySeconds: 7 * 24 * 3600 };
    // Never test tokens, never another token, never without a cap.
    await expect(
      chain.deploy({
        ...base,
        tokens: [{ code: 'TUSD', name: 'Test USD', decimals: 6, faucetLimit: 1n }],
        depositCaps: { TUSD: 1n },
      }),
    ).rejects.toThrow(/Test tokens are never deployed/);
    await expect(
      chain.deploy({
        ...base,
        tokens: [],
        existing: [{ code: CODE, address: '0x4200000000000000000000000000000000000006' }],
        depositCaps: { [CODE]: 1n },
      }),
    ).rejects.toThrow(/Only Base's USDC/);
    await expect(
      chain.deploy({ ...base, tokens: [], existing: [{ code: CODE, address: USDC }] }),
    ).rejects.toThrow(/finite deposit cap is required/);

    const { vault } = await chain.deploy({
      ...base,
      tokens: [],
      existing: [{ code: CODE, address: USDC }],
      depositCaps: { [CODE]: 1_000_000_000n }, // 1 000 USDC
    });
    expect(
      await client.readContract({
        address: vault,
        abi: VAULT,
        functionName: 'depositCap',
        args: [USDC],
      }),
    ).toBe(1_000_000_000n);

    const config = await chain.publicConfig();
    expect(config).toMatchObject({
      enabled: true,
      chainId: 8453,
      testnet: false,
      selfMint: false,
      faucet: false,
      tokens: [{ asset: CODE, decimals: 6, depositCap: '1000' }],
    });
    expect(config.network?.name).toBe('Base');
    await expect(chain.depositCapPrecheck(CODE, 'unlimited')).rejects.toThrow(
      /deposit cap is required/,
    );

    // A user with (fork-only) USDC signs in, deposits, and hits the cap.
    const key = generatePrivateKey();
    const user = privateKeyToAccount(key);
    await rpc('anvil_setBalance', [user.address, toHex(10n ** 17n)]);
    await giveUsdc(user.address, 2_000_000_000n);
    const wallet = createWalletClient({ account: user, transport: http(RPC) });
    const send = async (address: Hex, abi: never, functionName: string, args: unknown[]) => {
      const hash = await wallet.writeContract({
        address,
        abi,
        functionName,
        args,
        chain: null,
      });
      return (await client.waitForTransactionReceipt({ hash })).status;
    };
    expect(await send(USDC, ERC20 as never, 'approve', [vault, 2n ** 255n])).toBe('success');
    expect(await send(vault, VAULT as never, 'deposit', [USDC, 600_000_000n])).toBe('success');
    await expect(send(vault, VAULT as never, 'deposit', [USDC, 500_000_000n])).rejects.toThrow();

    const http_ = new TestClient(app);
    const n = (await http_.get('/v1/auth/wallet/nonce')).body as {
      nonce: string;
      domain: string;
      uri: string;
    };
    const message = [
      `${n.domain} wants you to sign in with your Ethereum account:`,
      user.address,
      '',
      'Sign in.',
      '',
      `URI: ${n.uri}`,
      'Version: 1',
      'Chain ID: 8453',
      `Nonce: ${n.nonce}`,
      `Issued At: ${new Date().toISOString()}`,
    ].join('\n');
    const login = await http_.post('/v1/auth/wallet/login', {
      message,
      signature: await user.signMessage({ message }),
    });
    expect(login.status).toBe(200);
    expect(await chain.indexOnce()).toBeGreaterThanOrEqual(1);
    const ledger = app.get(LedgerService);
    const me = (await http_.get('/v1/me')).body as { id: string };
    expect((await ledger.balancesForUser(me.id)).find((b) => b.asset === CODE)).toMatchObject({
      available: '600.000000',
    });

    // Withdraw 100 real-token USDC (on the fork) back to the wallet.
    const w = await http_.post('/v1/vault/withdrawals', { asset: CODE, amount: '100' });
    expect(w.status).toBe(201);
    const c = (w.body as { call: { withdrawal: Record<string, string>; signature: Hex } }).call;
    const before = await client.readContract({
      address: USDC,
      abi: ERC20,
      functionName: 'balanceOf',
      args: [user.address],
    });
    expect(
      await send(vault, VAULT as never, 'withdraw', [
        {
          id: c.withdrawal.id,
          user: c.withdrawal.user,
          token: c.withdrawal.token,
          amount: BigInt(c.withdrawal.amount!),
          afterState: BigInt(c.withdrawal.afterState!),
          expiry: BigInt(c.withdrawal.expiry!),
        },
        c.signature,
      ]),
    ).toBe('success');
    expect(
      await client.readContract({
        address: USDC,
        abi: ERC20,
        functionName: 'balanceOf',
        args: [user.address],
      }),
    ).toBe(before + 100_000_000n);
    await chain.indexOnce();
    const custody = await chain.custodyCheck();
    expect(custody).toEqual([expect.objectContaining({ asset: CODE, ok: true })]);
    // A second vault for the same asset is refused while this one holds funds.
    await expect(
      chain.deploy({
        ...base,
        tokens: [],
        existing: [{ code: CODE, address: USDC }],
        depositCaps: { [CODE]: 1n },
      }),
    ).rejects.toThrow(/previous vault still holds/);
    await expect(
      chain.deploy({
        ...base,
        tokens: [],
        existing: [{ code: 'USDCX', address: USDC }],
        depositCaps: { USDCX: 1n },
      }),
    ).rejects.toThrow(/already the asset/);

    // Leave the asset empty, so the next run (and a later real redeploy) may deploy again.
    const out = await http_.post('/v1/vault/withdrawals', { asset: CODE, amount: '500' });
    expect(out.status).toBe(201);
    const o = (out.body as { call: { withdrawal: Record<string, string>; signature: Hex } }).call;
    expect(
      await send(vault, VAULT as never, 'withdraw', [
        {
          id: o.withdrawal.id,
          user: o.withdrawal.user,
          token: o.withdrawal.token,
          amount: BigInt(o.withdrawal.amount!),
          afterState: BigInt(o.withdrawal.afterState!),
          expiry: BigInt(o.withdrawal.expiry!),
        },
        o.signature,
      ]),
    ).toBe('success');
    await chain.indexOnce();
    expect(await chain.custodyCheck()).toEqual([
      expect.objectContaining({ asset: CODE, ledger: '0', onChain: '0', ok: true }),
    ]);
  }, 300_000);
});
