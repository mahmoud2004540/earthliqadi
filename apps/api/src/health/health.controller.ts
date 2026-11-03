import { Controller, Get, HttpStatus, Inject, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { Public } from '../common/decorators';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { REDIS } from '../infrastructure/redis/redis.module';

type CheckStatus = 'up' | 'down';

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Liveness: the process is running (no dependency checks, so a DB outage does
 * not cause restart loops). Readiness: dependencies reachable; used by load
 * balancers to route traffic. Responses expose no versions or internals.
 */
@ApiTags('health')
@Public()
@SkipThrottle()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, CheckStatus> }> {
    const [database, redis] = await Promise.all([
      withTimeout(this.prisma.$queryRaw`SELECT 1`, 2000).then(
        () => 'up' as const,
        () => 'down' as const,
      ),
      withTimeout(this.redis.ping(), 2000).then(
        () => 'up' as const,
        () => 'down' as const,
      ),
    ]);
    const ok = database === 'up' && redis === 'up';
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    res.setHeader('Cache-Control', 'no-store');
    return { status: ok ? 'ok' : 'degraded', checks: { database, redis } };
  }
}
