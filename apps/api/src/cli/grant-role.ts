/**
 * Audited role-grant CLI — the ONLY way to create the first staff account.
 * There are no default/hidden administrator accounts.
 *
 * Usage (requires shell access to a deployment, which is itself access-controlled):
 *   pnpm --filter @platform/api cli:grant-role -- --email ops@example.com --role administrator --reason "TICKET-123"
 *
 * The target user must already be registered and verified. Every grant is
 * written to the append-only audit log with actor type SYSTEM.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { emailSchema, isRoleKey } from '@platform/shared';
import { parseArgs } from 'node:util';
import { AppModule } from '../app.module';
import { loadAppConfigOrExit } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';

async function run(): Promise<void> {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, role: { type: 'string' }, reason: { type: 'string' } },
  });
  const email = emailSchema.safeParse(values.email);
  if (
    !email.success ||
    !values.role ||
    !isRoleKey(values.role) ||
    !values.reason ||
    values.reason.length < 3
  ) {
    process.stderr.write(
      'Usage: grant-role --email <email> --role <role-key> --reason <ticket/justification>\n',
    );
    process.exit(64);
  }
  const config = loadAppConfigOrExit();
  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({ ...config, LOG_LEVEL: 'warn' }),
  );
  try {
    const prisma = app.get(PrismaService);
    const rbac = app.get(RbacService);
    await rbac.syncCatalogue();
    const user = await prisma.user.findUnique({ where: { email: email.data } });
    if (!user || user.status !== 'ACTIVE') {
      process.stderr.write('User not found or not active (email must be verified first).\n');
      process.exitCode = 1;
      return;
    }
    await rbac.grantRole({
      userId: user.id,
      roleKey: values.role,
      grantedById: null,
      actorType: 'SYSTEM',
      reason: `cli: ${values.reason}`,
    });
    process.stdout.write(`Granted role "${values.role}" to ${email.data}. Audit entry recorded.\n`);
  } finally {
    await app.close();
  }
}

void run();
