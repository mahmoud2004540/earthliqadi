import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import feedArtifact from '../src/chain/artifacts/TestPriceFeed.json';
import { LedgerService } from '../src/ledger/ledger.service';
import { parsePerpConfig } from '../src/perps/perp-config';
import { PerpRiskService } from '../src/perps/perp-risk.service';
import { PerpsService } from '../src/perps/perps.service';
import { MarketsService } from '../src/trading/markets.service';
import { bootApp } from './helpers';
import { SYSTEM } from './trading-helpers';

/**
 * Oracle index source (ADR-0016) against a Chainlink-compatible feed on the
 * local chain. Skipped when no local chain is reachable (required in CI).
 */
const RPC = process.env.TEST_CHAIN_RPC_URL ?? 'http://localhost:8545';
let app: INestApplication | null = null;
let reachable = false;
const saved = process.env.CHAIN_RPC_URL;

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
  await app?.close();
  if (saved === undefined) delete process.env.CHAIN_RPC_URL;
  else process.env.CHAIN_RPC_URL = saved;
});

it('prices a perpetual from an on-chain oracle feed and ignores invalid answers', async () => {
  if (!reachable) return;
  process.env.CHAIN_RPC_URL = RPC;
  app = await bootApp();
  const pub = createPublicClient({ transport: http(RPC), cacheTime: 0 });
  const account = privateKeyToAccount(generatePrivateKey());
  await pub.request({
    method: 'anvil_setBalance' as never,
    params: [account.address, '0x8AC7230489E80000'] as never, // 10 test ETH for gas
  });
  const wallet = createWalletClient({ account, transport: http(RPC) });
  const hash = await wallet.deployContract({
    abi: feedArtifact.abi as never,
    bytecode: feedArtifact.bytecode as Hex,
    args: [8, 'TEST BTC / USD'] as never,
    chain: null,
  });
  const feed = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  const setAnswer = async (value: bigint) => {
    const tx = await wallet.writeContract({
      address: feed,
      abi: feedArtifact.abi as never,
      functionName: 'setAnswer',
      args: [value] as never,
      chain: null,
    });
    expect((await pub.waitForTransactionReceipt({ hash: tx })).status).toBe('success');
  };

  const ledger = app.get(LedgerService);
  const code = (p: string) => `${p}${randomBytes(4).toString('hex').toUpperCase()}`;
  const base = code('OB');
  const quote = code('OQ');
  await ledger.createAsset({ code: base, name: 'Oracle base', scale: 8 }, SYSTEM);
  await ledger.createAsset({ code: quote, name: 'Oracle quote', scale: 6 }, SYSTEM);
  const market = await app.get(MarketsService).create(
    {
      base,
      quote,
      tickSize: '0.01',
      lotSize: '0.0001',
      makerFeeBps: 0,
      takerFeeBps: 0,
      kind: 'perpetual',
      perp: {
        defaultLeverage: 5,
        tiers: [{ maxNotional: '1000000', maxLeverage: 10, mmrBps: 500 }],
        fundingIntervalSeconds: 3600,
        fundingClampBps: 75,
        maxBasisBps: 50,
        liquidationFeeBps: 50,
        priceBandBps: 1000,
        index: {
          sources: [{ type: 'oracle', address: feed, label: 'TEST BTC / USD' }],
          staleSeconds: 3600,
          outlierBps: 500,
          minSources: 1,
        },
      },
    },
    SYSTEM,
  );
  const risk = app.get(PerpRiskService);
  const perps = app.get(PerpsService);
  const config = parsePerpConfig(market.perpConfig);

  // No round yet: no index, nothing is guessed.
  await risk.sample(market, config);
  expect((await perps.stats(market.symbol)).indexPrice).toBeNull();

  await setAnswer(65_432_10000000n); // 65 432.1 with 8 decimals
  await risk.sample(market, config);
  const stats = await perps.stats(market.symbol);
  expect(stats.indexPrice).toBe('65432.1');
  expect(stats.sourcesUsed).toBe(1);

  // A non-positive answer is ignored (the previous sample stays the latest).
  await setAnswer(0n);
  await risk.sample(market, config);
  expect((await perps.stats(market.symbol)).indexPrice).toBe('65432.1');

  const dto = app.get(MarketsService).toDto(market);
  expect(dto.perp!.indexSources[0]).toMatch(/^Oracle feed TEST BTC \/ USD/);
}, 120_000);
