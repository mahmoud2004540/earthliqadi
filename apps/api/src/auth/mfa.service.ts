import { toChecksumAddress } from './siwe';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { PasswordService } from '../security/password.service';
import { SecretBox } from '../security/secret-box';
import { base32Encode, generateTotpSecret, totpUri, verifyTotp } from '../security/totp';
import { SessionService } from './session.service';

/**
 * TOTP multi-factor authentication. Secrets are encrypted at rest with
 * AES-256-GCM and bound to the user id via AAD. Accepted time-steps are
 * recorded so a code cannot be replayed.
 *
 * Not yet implemented (tracked in docs/operations/known-issues.md):
 * recovery codes, WebAuthn/passkeys, mandatory MFA for staff roles.
 */
@Injectable()
export class MfaService {
  private readonly box: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.box = new SecretBox(config.MFA_ENCRYPTION_KEY);
  }

  private aad(userId: string): string {
    return `totp:${userId}`;
  }

  async beginSetup(
    userId: string,
    password: string,
    ctx: RequestContext,
  ): Promise<{ otpauthUri: string; secret: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabledAt) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'MFA_ALREADY_ENABLED',
        'Two-factor authentication is already enabled',
      );
    }
    await this.requirePassword(user, password, ctx, 'mfa.totp.setup');

    const secret = generateTotpSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaTotpPendingEnc: this.box.seal(secret, this.aad(userId)) },
    });
    await this.audit.record({
      action: 'mfa.totp.setup_started',
      outcome: 'SUCCESS',
      actorType: 'USER',
      actorUserId: userId,
      targetType: 'user',
      targetId: userId,
      context: ctx,
    });
    return {
      otpauthUri: totpUri({
        secret,
        issuer: this.config.BRAND_NAME,
        account: user.email ?? toChecksumAddress(user.walletAddress!),
      }),
      secret: base32Encode(secret),
    };
  }

  async confirmSetup(userId: string, code: string, ctx: RequestContext): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabledAt) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'MFA_ALREADY_ENABLED',
        'Two-factor authentication is already enabled',
      );
    }
    if (!user.mfaTotpPendingEnc) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'MFA_NOT_ENABLED', 'Start two-factor setup first');
    }
    const secret = this.box.open(user.mfaTotpPendingEnc, this.aad(userId));
    const step = verifyTotp(secret, code);
    if (step === null) {
      await this.audit.recordSafe({
        action: 'mfa.totp.enable',
        outcome: 'FAILURE',
        actorType: 'USER',
        actorUserId: userId,
        context: ctx,
      });
      throw new AppError(HttpStatus.BAD_REQUEST, 'MFA_INVALID', 'Invalid authentication code');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          mfaTotpSecretEnc: user.mfaTotpPendingEnc,
          mfaTotpPendingEnc: null,
          mfaEnabledAt: new Date(),
          mfaLastUsedStep: BigInt(step),
        },
      });
      await this.audit.record(
        {
          action: 'mfa.totp.enabled',
          outcome: 'SUCCESS',
          actorType: 'USER',
          actorUserId: userId,
          targetType: 'user',
          targetId: userId,
          context: ctx,
        },
        tx,
      );
    });
    if (user.email)
      await this.mail.send({
        to: user.email,
        kind: 'security_notice',
        subject: 'Two-factor authentication enabled',
        text: 'Two-factor authentication was enabled on your account. If this was not you, contact support immediately.',
      });
  }

  async disable(
    params: { userId: string; sessionId: string; password: string; code: string },
    ctx: RequestContext,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: params.userId } });
    if (!user.mfaEnabledAt) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'MFA_NOT_ENABLED',
        'Two-factor authentication is not enabled',
      );
    }
    await this.requirePassword(user, params.password, ctx, 'mfa.totp.disable');
    if (!(await this.verifyAndConsume(user, params.code))) {
      await this.audit.recordSafe({
        action: 'mfa.totp.disable',
        outcome: 'FAILURE',
        actorType: 'USER',
        actorUserId: user.id,
        context: ctx,
        metadata: { reason: 'bad_mfa_code' },
      });
      throw new AppError(HttpStatus.BAD_REQUEST, 'MFA_INVALID', 'Invalid authentication code');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          mfaTotpSecretEnc: null,
          mfaTotpPendingEnc: null,
          mfaEnabledAt: null,
          mfaLastUsedStep: null,
        },
      });
      await this.sessions.revokeAllForUser(user.id, 'mfa_disabled', {
        exceptSessionId: params.sessionId,
        tx,
      });
      await this.audit.record(
        {
          action: 'mfa.totp.disabled',
          outcome: 'SUCCESS',
          actorType: 'USER',
          actorUserId: user.id,
          targetType: 'user',
          targetId: user.id,
          context: ctx,
        },
        tx,
      );
    });
    if (user.email)
      await this.mail.send({
        to: user.email,
        kind: 'security_notice',
        subject: 'Two-factor authentication disabled',
        text: 'Two-factor authentication was disabled on your account and other sessions were signed out. If this was not you, contact support immediately.',
      });
  }

  /**
   * Verifies a TOTP code and atomically records its time-step. The conditional
   * update makes concurrent submissions of the same code fail (replay-safe).
   */
  async verifyAndConsume(user: User, code: string): Promise<boolean> {
    if (!user.mfaEnabledAt || !user.mfaTotpSecretEnc) return false;
    const secret = this.box.open(user.mfaTotpSecretEnc, this.aad(user.id));
    const lastUsed = user.mfaLastUsedStep === null ? null : Number(user.mfaLastUsedStep);
    const step = verifyTotp(secret, code, { lastUsedStep: lastUsed });
    if (step === null) return false;
    const result = await this.prisma.user.updateMany({
      where: {
        id: user.id,
        OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: BigInt(step) } }],
      },
      data: { mfaLastUsedStep: BigInt(step) },
    });
    return result.count === 1;
  }

  private async requirePassword(
    user: User,
    password: string,
    ctx: RequestContext,
    action: string,
  ): Promise<void> {
    if (user.passwordHash === null) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'CONFLICT',
        'Wallet accounts are protected by the wallet key; authenticator setup is for staff email accounts',
      );
    }
    if (await this.passwords.verify(user.passwordHash, password)) return;
    await this.audit.recordSafe({
      action,
      outcome: 'FAILURE',
      actorType: 'USER',
      actorUserId: user.id,
      context: ctx,
      metadata: { reason: 'bad_password' },
    });
    throw new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Password is incorrect');
  }
}
