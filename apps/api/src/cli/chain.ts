/**
 * Vault CLI (ADR-0014). Testnets and local chains only.
 *
 *   chain deploy [--freeze-delay 604800] [--suffix X] [--cap TUSD=100000 --cap TBTC=2]
 *                                          # test tokens TUSD (6) + TBTC (8), the vault,
 *                                          # and the markets TBTC-TUSD (spot) and TBTC-TUSD-PERP
 *                                          # Public testnet (ADR-0034): CHAIN_DEPLOYER_KEY=0x… pays
 *                                          # for the deployment; --operator 0x… is the signer's wallet.
 *   CHAIN_MAINNET=true (ADR-0038): `chain deploy --cap USDC=5000` deploys only the vault,
 *                                          # with the network's real USDC and a required cap;
 *                                          # no test tokens and no markets (add perps with
 *                                          # verified oracle feeds through the admin API).
 *   chain index                            # one indexer pass
 *   chain commit                           # snapshot + commit the balance root
 *   chain custody                          # ledger vs on-chain custody
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import { mainNetwork, parseAmount } from '@platform/shared';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AppModule } from '../app.module';
import { ChainService } from '../chain/chain.service';
import { MarketsService } from '../trading/markets.service';
import { loadAppConfigOrExit } from '../config/app-config';

async function run(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'freeze-delay': { type: 'string' },
      suffix: { type: 'string' },
      /** Launch guard per token (ADR-0033), whole units: --cap TUSD=100000 */
      cap: { type: 'string', multiple: true },
      /** Vault operator (the signer's wallet). Default: ask the configured signer. */
      operator: { type: 'string' },
    },
  });
  const config = loadAppConfigOrExit();
  // CLI runs never start the background workers.
  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({
      ...config,
      LOG_LEVEL: 'warn',
      LEDGER_RECONCILIATION_INTERVAL_SECONDS: 0,
      CHAIN_POLL_MS: 0,
      VAULT_STATE_INTERVAL_SECONDS: 0,
      SETTLEMENT_POLL_MS: 0,
      PERP_RISK_POLL_MS: 0,
      CANCEL_TIMER_POLL_MS: 0,
      GROWTH_JOB_INTERVAL_SECONDS: 0,
      ALGO_POLL_MS: 0,
    }),
  );
  const chain = app.get(ChainService);
  try {
    if (!chain.enabled) throw new Error('CHAIN_RPC_URL is not set');
    switch (positionals[0]) {
      case 'deploy': {
        // Asset codes are permanent once linked to a token: redeploys use a --suffix.
        const sfx = (values.suffix ?? '').toUpperCase();
        if (!/^[A-Z0-9]{0,8}$/.test(sfx)) throw new Error('--suffix: up to 8 of [A-Z0-9]');
        const real = config.CHAIN_MAINNET;
        const depositCaps: Record<string, bigint> = {};
        for (const c of values.cap ?? []) {
          const m = /^([A-Z0-9]+)=(\d+(?:\.\d+)?)$/.exec(c);
          if (!m) throw new Error(`--cap: expected CODE=AMOUNT, got "${c}"`);
          const known: Record<string, number> = real ? { USDC: 6 } : { TBTC: 8, TUSD: 6 };
          const decimals = known[m[1]!];
          if (decimals === undefined)
            throw new Error(`--cap: unknown token ${m[1]} (${Object.keys(known).join(' or ')})`);
          depositCaps[real ? m[1]! : `${m[1]}${sfx}`] = parseAmount(m[2]!, decimals);
        }
        // A one-off deployer key (public testnets) is read here only, never by the server.
        const deployerKey = process.env.CHAIN_DEPLOYER_KEY;
        let deployer: Parameters<ChainService['deploy']>[0]['deployer'];
        if (deployerKey) {
          if (!/^0x[0-9a-fA-F]{64}$/.test(deployerKey))
            throw new Error('CHAIN_DEPLOYER_KEY must be a 0x-prefixed 32-byte hex key');
          if (!config.CHAIN_RPC_URL) throw new Error('CHAIN_RPC_URL is required');
          const account = privateKeyToAccount(deployerKey as Hex);
          const wallet = createWalletClient({ account, transport: http(config.CHAIN_RPC_URL) });
          const gas = await createPublicClient({
            transport: http(config.CHAIN_RPC_URL),
          }).getBalance({ address: account.address });
          if (gas === 0n)
            throw new Error(
              real
                ? `The deployer ${account.address} has no ETH for gas`
                : `The deployer ${account.address} has no test ETH for gas; fund it from a testnet faucet first`,
            );
          deployer = { wallet, account };
        }
        if (values.operator !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(values.operator))
          throw new Error('--operator must be a 0x-prefixed address');
        if (real) {
          // Real funds: the network's USDC only, a required cap, no markets here.
          const net = mainNetwork(await chain.chainId());
          if (!net) throw new Error('This RPC is not an allowed real-value network');
          if (!deployer) throw new Error('CHAIN_DEPLOYER_KEY is required on a real network');
          if (!values.operator) throw new Error('--operator is required on a real network');
          const r = await chain.deploy({
            deployer,
            operator: values.operator as Hex,
            depositCaps,
            tokens: [],
            existing: [{ code: 'USDC', address: net.usdc as Hex }],
            freezeDelaySeconds: Number(values['freeze-delay'] ?? 7 * 24 * 3600),
          });
          process.stdout.write(`${JSON.stringify({ ...r, network: net.name }, null, 2)}\n`);
          break;
        }
        const r = await chain.deploy({
          deployer,
          operator: values.operator as Hex | undefined,
          depositCaps,
          tokens: [
            { code: `TUSD${sfx}`, name: 'Test USD', decimals: 6, faucetLimit: 10n ** 15n },
            { code: `TBTC${sfx}`, name: 'Test BTC', decimals: 8, faucetLimit: 10n ** 12n },
          ],
          freezeDelaySeconds: Number(values['freeze-delay'] ?? 7 * 24 * 3600),
        });
        // Vault-backed markets on the new tokens. The perpetual's index is the
        // spot mid price; on public testnets add real oracle feeds via the admin API.
        const usd = `TUSD${sfx}`;
        const btc = `TBTC${sfx}`;
        const actor = { actorType: 'SYSTEM' as const, requestId: 'cli:chain-deploy' };
        const markets = app.get(MarketsService);
        const spot = await markets.create(
          {
            base: btc,
            quote: usd,
            tickSize: '0.01',
            lotSize: '0.0001',
            makerFeeBps: 2,
            takerFeeBps: 5,
          },
          actor,
        );
        const perp = await markets.create(
          {
            base: btc,
            quote: usd,
            tickSize: '0.01',
            lotSize: '0.0001',
            makerFeeBps: 2,
            takerFeeBps: 5,
            kind: 'perpetual',
            perp: {
              defaultLeverage: 10,
              tiers: [
                { maxNotional: '250000', maxLeverage: 20, mmrBps: 250 },
                { maxNotional: '2500000', maxLeverage: 10, mmrBps: 500 },
              ],
              fundingIntervalSeconds: 3600,
              fundingClampBps: 75,
              maxBasisBps: 50,
              liquidationFeeBps: 50,
              priceBandBps: 1000,
              index: {
                sources: [{ type: 'spot', market: spot.symbol }],
                staleSeconds: 60,
                outlierBps: 500,
                minSources: 1,
              },
            },
          },
          actor,
        );
        process.stdout.write(
          `${JSON.stringify({ ...r, markets: [spot.symbol, perp.symbol] }, null, 2)}\n`,
        );
        break;
      }
      case 'index':
        process.stdout.write(`events: ${await chain.indexOnce()}\n`);
        break;
      case 'commit':
        process.stdout.write(`state index: ${String(await chain.commitState())}\n`);
        break;
      case 'custody': {
        const rows = await chain.custodyCheck();
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        if (rows.some((r) => !r.ok)) process.exitCode = 2;
        break;
      }
      default:
        throw new Error('usage: chain deploy|index|commit|custody');
    }
  } finally {
    await app.close();
  }
}

run().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
