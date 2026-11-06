import { HttpStatus, Inject, Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../common/app-error';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { AccessService } from './access.service';

/** Paths a restricted location can still reach: the status that explains the block, and probes. */
export function isRegionBlockExempt(path: string): boolean {
  return (
    path === '/v1/access' ||
    path === '/health' ||
    path.startsWith('/health/') ||
    path === '/metrics'
  );
}

export const REGION_BLOCKED_MESSAGE =
  'This service is not available in your region. Funds committed to the vault contract remain withdrawable on-chain through its escape hatch.';

/**
 * GEO_RESTRICTED_MODE=block_all (ADR-0024): every request from a restricted
 * location is refused before authentication, including sign-in, cancels and
 * withdrawals through the platform.
 */
@Injectable()
export class RegionBlockMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RegionBlockMiddleware.name);

  constructor(
    private readonly access: AccessService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    if (this.config.GEO_RESTRICTED_MODE !== 'block_all') return next();
    const path = (req.originalUrl ?? req.url).split('?')[0] ?? '';
    if (isRegionBlockExempt(path)) return next();
    const loc = this.access.locationOf(req);
    if (!this.access.regionRestricted(loc)) return next();
    this.logger.debug({ ...loc, path }, 'REGION_BLOCKED');
    next(new AppError(451 as HttpStatus, 'REGION_RESTRICTED', REGION_BLOCKED_MESSAGE));
  }
}
