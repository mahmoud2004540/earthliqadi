import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type KycCase } from '@prisma/client';
import type {
  KycCaseStatusDto,
  KycReviewDto,
  KycStatusDto,
  KycSubmitInput,
} from '@platform/shared';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SecretBox } from '../security/secret-box';
import { SANCTIONS_SCREENER, type SanctionsScreener } from './sanctions';

interface Screening {
  restrictedCountry: boolean;
  sanctions: 'not_screened' | 'clear' | 'hit';
  sanctionsProvider: string;
}

function conflict(message: string): AppError {
  return new AppError(HttpStatus.CONFLICT, 'CONFLICT', message);
}

/**
 * Identity verification workflow (ADR-0012): users submit a basic profile,
 * which is encrypted at rest (AES-256-GCM, bound to the case id) and screened
 * (restricted countries; sanctions through a provider boundary). A compliance
 * officer reviews it. Decrypted profiles are shown only on the single-case
 * endpoint, and every such view is audited. Profiles are never logged.
 */
@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);
  private readonly box: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(SANCTIONS_SCREENER) private readonly screener: SanctionsScreener,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.box = new SecretBox(config.PII_ENCRYPTION_KEY ?? config.MFA_ENCRYPTION_KEY);
  }

  private aad(caseId: string): string {
    return `kyc:${caseId}`;
  }

  async status(userId: string): Promise<KycStatusDto> {
    const [user, latest] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { kycLevel: true } }),
      this.prisma.kycCase.findFirst({ where: { userId }, orderBy: { submittedAt: 'desc' } }),
    ]);
    return {
      level: user.kycLevel,
      case: latest
        ? {
            id: latest.id,
            status: latest.status.toLowerCase() as KycCaseStatusDto,
            submittedAt: latest.submittedAt.toISOString(),
            decidedAt: latest.decidedAt?.toISOString() ?? null,
            note: latest.status === 'APPROVED' ? null : latest.decisionNote,
          }
        : null,
    };
  }

  async submit(
    userId: string,
    profile: KycSubmitInput,
    ctx: RequestContext,
  ): Promise<KycStatusDto> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.kycLevel >= 1) throw conflict('Your identity is already verified');
    const open = await this.prisma.kycCase.findFirst({
      where: { userId, status: { in: ['PENDING', 'NEEDS_INFO'] } },
    });
    const screening: Screening = {
      restrictedCountry: this.config.RESTRICTED_COUNTRIES.includes(profile.countryCode),
      sanctions: await this.screener.screen(profile),
      sanctionsProvider: this.screener.name,
    };
    const id = randomUUID();
    const sealed = this.box.seal(Buffer.from(JSON.stringify(profile), 'utf8'), this.aad(id));
    try {
      await this.prisma.$transaction(async (tx) => {
        // Resubmitting after "needs info" closes the old case as superseded.
        if (open?.status === 'NEEDS_INFO') {
          await tx.kycCase.update({
            where: { id: open.id },
            data: {
              status: 'REJECTED',
              decidedAt: new Date(),
              decisionNote: 'Superseded by a new submission',
            },
          });
        } else if (open) {
          throw conflict('A verification request is already under review');
        }
        await tx.kycCase.create({
          data: {
            id,
            userId,
            level: 1,
            profileEnc: sealed,
            countryCode: profile.countryCode,
            screening: screening as unknown as Prisma.InputJsonValue,
          },
        });
        await this.audit.record(
          {
            action: 'kyc.submitted',
            outcome: 'SUCCESS',
            actorType: 'USER',
            actorUserId: userId,
            targetType: 'kyc_case',
            targetId: id,
            context: ctx,
            // Never the profile itself.
            metadata: { country: profile.countryCode, screening },
          },
          tx,
        );
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw conflict('A verification request is already under review');
      throw err;
    }
    return this.status(userId);
  }

  private reviewDto(
    c: KycCase & { user: { email: string } },
    profile?: KycSubmitInput,
  ): KycReviewDto {
    return {
      id: c.id,
      userId: c.userId,
      email: c.user.email,
      status: c.status.toLowerCase() as KycCaseStatusDto,
      level: c.level,
      countryCode: c.countryCode,
      screening: c.screening as unknown as Screening,
      submittedAt: c.submittedAt.toISOString(),
      ...(profile ? { profile } : {}),
    };
  }

  async queue(status: 'pending' | 'all', limit: number): Promise<KycReviewDto[]> {
    const rows = await this.prisma.kycCase.findMany({
      where: status === 'pending' ? { status: 'PENDING' } : {},
      include: { user: { select: { email: true } } },
      orderBy: { submittedAt: 'asc' },
      take: limit,
    });
    return rows.map((c) => this.reviewDto(c));
  }

  async reviewCase(caseId: string, reviewerId: string, ctx: RequestContext): Promise<KycReviewDto> {
    const c = await this.prisma.kycCase.findUnique({
      where: { id: caseId },
      include: { user: { select: { email: true } } },
    });
    if (!c) throw AppError.notFound('Case not found');
    if (c.userId === reviewerId) throw AppError.forbidden('You cannot review your own case');
    const profile = JSON.parse(
      this.box.open(c.profileEnc, this.aad(c.id)).toString('utf8'),
    ) as KycSubmitInput;
    await this.audit.record({
      action: 'kyc.case.viewed',
      outcome: 'SUCCESS',
      actorType: 'STAFF',
      actorUserId: reviewerId,
      targetType: 'kyc_case',
      targetId: c.id,
      context: ctx,
    });
    return this.reviewDto(c, profile);
  }

  async decide(
    caseId: string,
    reviewerId: string,
    decision: 'approve' | 'reject' | 'needs_info',
    note: string,
    ctx: RequestContext,
  ): Promise<KycReviewDto> {
    const c = await this.prisma.kycCase.findUnique({ where: { id: caseId } });
    if (!c) throw AppError.notFound('Case not found');
    if (c.userId === reviewerId) throw AppError.forbidden('You cannot review your own case');
    if (c.status !== 'PENDING') throw conflict(`Case is ${c.status.toLowerCase()}, not pending`);
    const screening = c.screening as unknown as Screening;
    if (decision === 'approve') {
      if (screening.restrictedCountry)
        throw conflict('Applicants from restricted countries cannot be approved');
      if (screening.sanctions === 'hit')
        throw conflict('Sanctions screening hit: escalate, do not approve');
      const lenient = this.config.DEPLOY_ENV === 'local' || this.config.DEPLOY_ENV === 'ci';
      if (screening.sanctions === 'not_screened' && !lenient)
        throw conflict('Sanctions screening has not run; a screening provider is required');
    }
    const status =
      decision === 'approve' ? 'APPROVED' : decision === 'reject' ? 'REJECTED' : 'NEEDS_INFO';
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.kycCase.updateMany({
        where: { id: caseId, status: 'PENDING' },
        data: {
          status,
          reviewerId,
          decisionNote: note,
          decidedAt: decision === 'needs_info' ? null : new Date(),
        },
      });
      if (updated.count !== 1) throw conflict('Case was decided in the meantime');
      if (decision === 'approve') {
        await tx.user.update({ where: { id: c.userId }, data: { kycLevel: c.level } });
      }
      await this.audit.record(
        {
          action: `kyc.case.${decision}`,
          outcome: 'SUCCESS',
          actorType: 'STAFF',
          actorUserId: reviewerId,
          targetType: 'kyc_case',
          targetId: caseId,
          context: ctx,
          metadata: { userId: c.userId, note, screening },
        },
        tx,
      );
      await this.notifications.notify(
        {
          userId: c.userId,
          kind: 'kyc.decided',
          title:
            decision === 'approve'
              ? 'Identity verified'
              : decision === 'reject'
                ? 'Identity verification was not approved'
                : 'More information needed for verification',
          body: decision === 'approve' ? 'Your identity verification was approved.' : note,
          data: { caseId },
        },
        tx,
      );
    });
    this.logger.log({ caseId, decision }, 'KYC decision recorded');
    const fresh = await this.prisma.kycCase.findUniqueOrThrow({
      where: { id: caseId },
      include: { user: { select: { email: true } } },
    });
    return this.reviewDto(fresh);
  }
}
