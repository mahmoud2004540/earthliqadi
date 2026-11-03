import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AccountModule } from './account/account.module';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CsrfGuard, PermissionsGuard, SessionAuthGuard } from './auth/guards';
import { AUTH_RATE_LIMIT_KEY } from './common/decorators';
import type { AppConfig } from './config/app-config';
import { ConfigModule } from './config/config.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { REDIS, RedisModule } from './infrastructure/redis/redis.module';
import { RedisThrottlerStorage } from './infrastructure/throttler/redis-throttler.storage';
import { MailModule } from './mail/mail.module';
import { RbacModule } from './rbac/rbac.module';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.LOG_LEVEL,
            // Accept a well-formed upstream request id (from the proxy) or mint one.
            genReqId: (req: IncomingMessage) => {
              const incoming = req.headers['x-request-id'];
              return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
                ? incoming
                : randomUUID();
            },
            redact: {
              paths: [
                'req.headers.cookie',
                'req.headers.authorization',
                'req.headers["x-csrf-token"]',
                'res.headers["set-cookie"]',
              ],
              censor: '[REDACTED]',
            },
            customProps: () => ({ service: 'api', deployEnv: config.DEPLOY_ENV }),
            autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
          },
        }),
        PrismaModule,
        RedisModule,
        ThrottlerModule.forRootAsync({
          inject: [REDIS],
          useFactory: (redis: Redis) => ({
            storage: new RedisThrottlerStorage(redis),
            throttlers: [
              { name: 'default', ttl: 60_000, limit: config.RATE_LIMIT_DEFAULT_PER_MINUTE },
              {
                name: 'auth',
                ttl: 60_000,
                limit: config.RATE_LIMIT_AUTH_PER_MINUTE,
                skipIf: (ctx) =>
                  Reflect.getMetadata(AUTH_RATE_LIMIT_KEY, ctx.getHandler()) !== true,
              },
            ],
          }),
        }),
        AuditModule,
        MailModule,
        RbacModule,
        AuthModule,
        AccountModule,
        AdminModule,
      ],
      controllers: [HealthController],
      providers: [
        // Order matters: rate limit → CSRF → authenticate → authorise.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useExisting: CsrfGuard },
        { provide: APP_GUARD, useExisting: SessionAuthGuard },
        { provide: APP_GUARD, useExisting: PermissionsGuard },
      ],
    };
  }
}
