import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { AccessStatusDto, MyAccessStatusDto } from '@platform/shared';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import {
  decide,
  locationFrom,
  normaliseAddress,
  regionRestricted,
  type AccessKind,
  type Location,
} from './access-policy';

const MESSAGES = {
  SANCTIONED_ADDRESS: 'This wallet cannot use the platform',
  REGION_RESTRICTED:
    'This service is not available in your region. You can still close positions, cancel orders and withdraw.',
  TERMS_NOT_ACCEPTED: 'Accept the current terms of use to continue',
} as const;

/** Restricted regions, sanctions screening and terms acceptance (ADR-0022). */
@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  locationOf(req: Pick<Request, 'headers'>): Location {
    return locationFrom(req.headers, this.config);
  }

  regionRestricted(loc: Location): boolean {
    return regionRestricted(loc, this.config);
  }

  async isSanctioned(address: string | null): Promise<boolean> {
    const a = address ? normaliseAddress(address) : null;
    if (!a) return false;
    return (await this.prisma.sanctionedAddress.count({ where: { address: a } })) > 0;
  }

  /** The wallet account that answers for this account (itself, or its parent). */
  private async principal(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, parentUserId: true, walletAddress: true, termsAcceptedVersion: true },
    });
    if (!u.parentUserId) return u;
    return this.prisma.user.findUniqueOrThrow({
      where: { id: u.parentUserId },
      select: { id: true, parentUserId: true, walletAddress: true, termsAcceptedVersion: true },
    });
  }

  /** Throws when the policy refuses this request; audited. */
  async enforce(
    userId: string,
    kind: AccessKind,
    loc: Location,
    reduceOnly: boolean,
    ctx: RequestContext,
    route: string,
  ): Promise<void> {
    const p = await this.principal(userId);
    const facts = {
      regionRestricted: this.regionRestricted(loc),
      reduceOnly,
      sanctioned: await this.isSanctioned(p.walletAddress),
      termsAccepted: p.termsAcceptedVersion === this.config.TERMS_VERSION,
    };
    const d = decide(kind, facts);
    if (d.allow) return;
    // Terms prompts are routine; region and sanctions refusals are audited.
    if (d.code !== 'TERMS_NOT_ACCEPTED')
      await this.audit.recordSafe({
        action: 'access.denied',
        outcome: 'DENIED',
        actorType: 'USER',
        actorUserId: userId,
        targetType: 'route',
        targetId: route.slice(0, 128),
        context: ctx,
        metadata: { reason: d.code, ...loc, kind },
      });
    throw new AppError(
      d.code === 'REGION_RESTRICTED'
        ? (451 as HttpStatus) /* Unavailable For Legal Reasons */
        : HttpStatus.FORBIDDEN,
      d.code,
      MESSAGES[d.code],
    );
  }

  status(loc: Location): AccessStatusDto {
    return {
      country: loc.country,
      subdivision: loc.subdivision,
      regionRestricted: this.regionRestricted(loc),
      restrictedMode: this.config.GEO_RESTRICTED_MODE,
      restrictedCountries: this.config.RESTRICTED_COUNTRIES,
      restrictedSubdivisions: this.config.RESTRICTED_SUBDIVISIONS,
      termsVersion: this.config.TERMS_VERSION,
    };
  }

  async myStatus(userId: string, loc: Location): Promise<MyAccessStatusDto> {
    const p = await this.principal(userId);
    return {
      ...this.status(loc),
      termsAcceptedVersion: p.termsAcceptedVersion,
      termsAccepted: p.termsAcceptedVersion === this.config.TERMS_VERSION,
      sanctioned: await this.isSanctioned(p.walletAddress),
    };
  }

  /** Records acceptance of the current version. Sub-accounts accept through their parent. */
  async acceptTerms(
    userId: string,
    version: string,
    loc: Location,
    ctx: RequestContext,
  ): Promise<MyAccessStatusDto> {
    if (version !== this.config.TERMS_VERSION)
      throw new AppError(
        HttpStatus.CONFLICT,
        'CONFLICT',
        'The terms of use have changed; reload and review the current version',
      );
    const p = await this.principal(userId);
    if (p.id !== userId) throw AppError.forbidden('Accept the terms from the main account');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { termsAcceptedVersion: version, termsAcceptedAt: new Date() },
      });
      await this.audit.record(
        {
          action: 'access.terms.accepted',
          outcome: 'SUCCESS',
          actorType: 'USER',
          actorUserId: userId,
          targetType: 'user',
          targetId: userId,
          context: ctx,
          metadata: { version, ...loc },
        },
        tx,
      );
    });
    return this.myStatus(userId, loc);
  }

  /**
   * Replaces the addresses of one list source with `addresses` (operator CLI).
   * Returns how many were added and removed.
   */
  async replaceSanctionsList(
    source: string,
    addresses: string[],
  ): Promise<{ added: number; removed: number; total: number }> {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(source)) throw new Error('invalid source name');
    const wanted = new Set(addresses.map((a) => normaliseAddress(a)).filter((a) => a !== null));
    return this.prisma.$transaction(async (tx) => {
      const current = new Set(
        (await tx.sanctionedAddress.findMany({ where: { source }, select: { address: true } })).map(
          (r) => r.address,
        ),
      );
      const add = [...wanted].filter((a) => !current.has(a));
      const remove = [...current].filter((a) => !wanted.has(a));
      if (remove.length)
        await tx.sanctionedAddress.deleteMany({ where: { source, address: { in: remove } } });
      if (add.length)
        await tx.sanctionedAddress.createMany({
          data: add.map((address) => ({ address, source })),
        });
      await this.audit.record(
        {
          action: 'access.sanctions.list_replaced',
          outcome: 'SUCCESS',
          actorType: 'SYSTEM',
          targetType: 'sanctions_list',
          targetId: source,
          metadata: { added: add.length, removed: remove.length, total: wanted.size },
        },
        tx,
      );
      return { added: add.length, removed: remove.length, total: wanted.size };
    });
  }

  async sanctionsSummary(): Promise<{ source: string; addresses: number }[]> {
    const rows = await this.prisma.sanctionedAddress.groupBy({ by: ['source'], _count: true });
    return rows.map((r) => ({ source: r.source, addresses: r._count }));
  }
}
