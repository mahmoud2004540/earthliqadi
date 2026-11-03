/**
 * Vault CLI (ADR-0014). Testnets and local chains only.
 *
 *   chain deploy [--freeze-delay 604800] [--suffix X]  # test tokens TUSD (6) + TBTC (8) and the vault
 *   chain index                            # one indexer pass
 *   chain commit                           # snapshot + commit the balance root
 *   chain custody                          # ledger vs on-chain custody
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import { AppModule } from '../app.module';
import { ChainService } from '../chain/chain.service';
import { loadAppConfigOrExit } from '../config/app-config';

async function run(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { 'freeze-delay': { type: 'string' }, suffix: { type: 'string' } },
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
        const r = await chain.deploy({
          tokens: [
            { code: `TUSD${sfx}`, name: 'Test USD', decimals: 6, faucetLimit: 10n ** 15n },
            { code: `TBTC${sfx}`, name: 'Test BTC', decimals: 8, faucetLimit: 10n ** 12n },
          ],
          freezeDelaySeconds: Number(values['freeze-delay'] ?? 7 * 24 * 3600),
        });
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
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
