/**
 * Ledger operations CLI (audited).
 *
 *   ledger create-asset --code BTC --name "Bitcoin (test)" --scale 8
 *   ledger sim-deposit  --email user@example.test --asset BTC --amount 0.5     # local/ci ONLY
 *   ledger reconcile
 *
 * Creating an asset is configuration, not a listing announcement.
 * `sim-deposit` mints simulated funds and is refused outside DEPLOY_ENV=local|ci.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createAssetSchema, emailSchema, formatAmount, parseAmount } from '@platform/shared';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { AppModule } from '../app.module';
import { loadAppConfigOrExit } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { ReconciliationService } from '../ledger/reconciliation.service';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}

async function run(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      code: { type: 'string' },
      name: { type: 'string' },
      scale: { type: 'string' },
      email: { type: 'string' },
      asset: { type: 'string' },
      amount: { type: 'string' },
    },
  });
  const command = positionals[0];
  if (!command || !['create-asset', 'sim-deposit', 'reconcile'].includes(command)) {
    fail('Usage: ledger <create-asset|sim-deposit|reconcile> [options]');
  }

  const config = loadAppConfigOrExit();
  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({ ...config, LOG_LEVEL: 'warn', LEDGER_RECONCILIATION_INTERVAL_SECONDS: 0 }),
  );
  const actor = { actorType: 'SYSTEM' as const, requestId: `cli:${randomUUID()}` };
  try {
    const ledger = app.get(LedgerService);
    if (command === 'create-asset') {
      const input = createAssetSchema.safeParse({
        code: values.code,
        name: values.name,
        scale: Number(values.scale),
      });
      if (!input.success)
        fail(
          `Invalid asset: ${input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      const asset = await ledger.createAsset(input.data, actor);
      process.stdout.write(`Created asset ${asset.code} (scale ${asset.scale}).\n`);
    } else if (command === 'sim-deposit') {
      const email = emailSchema.safeParse(values.email);
      if (!email.success || !values.asset || !values.amount)
        fail('Usage: ledger sim-deposit --email <email> --asset <CODE> --amount <decimal>');
      const user = await app.get(PrismaService).user.findUnique({ where: { email: email.data } });
      if (!user) fail('User not found');
      const asset = await ledger.requireAsset(values.asset.toUpperCase());
      const amount = parseAmount(values.amount, asset.scale);
      if (amount <= 0n) fail('Amount must be positive');
      const result = await ledger.simulatedDeposit(
        {
          userId: user.id,
          assetCode: asset.code,
          amount,
          idempotencyKey: `cli-sim-deposit:${randomUUID()}`,
        },
        actor,
      );
      process.stdout.write(
        `Simulated deposit of ${formatAmount(amount, asset.scale)} ${asset.code} posted as entry ${result.entry.id}. NOT real funds.\n`,
      );
    } else {
      const result = await app.get(ReconciliationService).run('CLI');
      process.stdout.write(
        `Reconciliation ${result.status}: ${result.accountsChecked} accounts, ${result.entriesChecked} entries.\n`,
      );
      if (result.status !== 'OK') {
        process.stdout.write(`${JSON.stringify(result.findings, null, 2)}\n`);
        process.exitCode = 2;
      }
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void run();
