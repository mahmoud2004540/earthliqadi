/**
 * Sanctions list CLI (ADR-0022). The platform ships with no list: operators
 * load official lists (for example the wallet addresses published in OFAC's
 * SDN list) as plain text, one address per line. Lines that are not
 * addresses (comments, blanks) are ignored.
 *
 *   sanctions import <file> --source <name>   # replace the list of that source
 *   sanctions summary                         # addresses per source
 *   sanctions check <address>                 # is this address listed?
 *   sanctions sync-ofac [--file f] [--force]  # load OFAC's SDN list (download or file)
 *
 * The API also runs sync-ofac on a timer when SANCTIONS_SYNC_HOURS > 0 (ADR-0023).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { normaliseAddress } from '../access/access-policy';
import { AccessService } from '../access/access.service';
import { SanctionsSyncService } from '../access/sanctions-sync.service';
import { AppModule } from '../app.module';
import { loadAppConfigOrExit } from '../config/app-config';

async function run(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      file: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });
  const config = loadAppConfigOrExit();
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
      MARKET_DATA_POLL_MS: 0,
      SANCTIONS_SYNC_HOURS: 0,
    }),
  );
  const access = app.get(AccessService);
  try {
    switch (positionals[0]) {
      case 'import': {
        const file = positionals[1];
        if (!file || !values.source)
          throw new Error('usage: sanctions import <file> --source <name>');
        const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
        const addresses = lines.map(normaliseAddress).filter((a) => a !== null);
        if (addresses.length === 0)
          throw new Error('no addresses found; refusing to empty the list by accident');
        const r = await access.replaceSanctionsList(values.source, addresses);
        process.stdout.write(
          `${values.source}: ${r.total} addresses (added ${r.added}, removed ${r.removed})\n`,
        );
        break;
      }
      case 'summary': {
        const rows = await access.sanctionsSummary();
        if (rows.length === 0) process.stdout.write('no sanctions list loaded\n');
        for (const r of rows) process.stdout.write(`${r.source}: ${r.addresses}\n`);
        break;
      }
      case 'check': {
        const a = positionals[1] ? normaliseAddress(positionals[1]) : null;
        if (!a) throw new Error('usage: sanctions check <0x address>');
        process.stdout.write(`${a}: ${(await access.isSanctioned(a)) ? 'LISTED' : 'not listed'}\n`);
        break;
      }
      case 'sync-ofac': {
        const text = values.file ? await readFile(values.file, 'utf8') : undefined;
        const r = await app.get(SanctionsSyncService).syncOfac({ text, force: values.force });
        process.stdout.write(
          `${r.source}: ${r.total} addresses (added ${r.added}, removed ${r.removed})\n`,
        );
        break;
      }
      default:
        throw new Error('usage: sanctions import|summary|check|sync-ofac');
    }
  } finally {
    await app.close();
  }
}

run().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
