import { verifySiwe } from './siwe';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, type TokenPurpose, type User } from '@prisma/client';
import type { LoginResultDto } from '@platform/shared';
import type Redis from 'ioredis';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { REDIS } from '../infrastructure/redis/redis.module';
import { MailService } from '../mail/mail.service';
import { RbacService } from '../rbac/rbac.service';
import { randomToken, sha256Hex } from '../security/crypto';
import { PasswordService } from '../security/password.service';
import { MfaService } from './mfa.service';
import { SessionService } from './session.service';
import { toCurrentUserDto } from './user-dto';

const EMAIL_VERIFICATION_TTL_MS = 24 * 3600_000;
const PASSWORD_RESET_TTL_MS = 3600_000;
const MFA_CHALLENGE_TTL_SECONDS = 300;
const MFA_CHALLENGE_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

interface MfaChallenge {
  userId: string;
  attempts: number;
}

export type LoginOutcome =
  | { kind: 'authenticated'; sessionToken: string; result: LoginResultDto }
  | { kind: 'mfa_required'; result: LoginResultDto };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly mfa: MfaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------- registration

  /**
   * Always resolves the same way whether or not the email is registered
   * (prevents account enumeration). An existing account owner receives a
   * security notice instead of a second account.
   */
  async register(input: { email: string; password: string }, ctx: RequestContext): Promise<void> {
    // Hash first so timing does not depend on whether the account exists.
    const passwordHash = await this.passwords.hash(input.password);
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      await this.audit.recordSafe({
        action: 'auth.register.duplicate',
        outcome: 'FAILURE',
        actorType: 'ANONYMOUS',
        targetType: 'user',
        targetId: existing.id,
        context: ctx,
      });
      await this.mail.send({
        to: existing.email!,
        kind: 'security_notice',
        subject: 'Registration attempt on your account',
        text:
          'Someone tried to create an account with this email address. If this was you, sign in or reset your password.\n' +
          `${this.config.WEB_ORIGIN}/forgot-password`,
      });
      return;
    }

    let created: { user: User; token: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: input.email, passwordHash },
        });
        await this.rbac.assignDefaultRole(user.id, tx);
        const token = await this.createToken(
          user.id,
          'EMAIL_VERIFICATION',
          EMAIL_VERIFICATION_TTL_MS,
          tx,
        );
        await this.audit.record(
          {
            action: 'auth.register',
            outcome: 'SUCCESS',
            actorType: 'USER',
            actorUserId: user.id,
            targetType: 'user',
            targetId: user.id,
            context: ctx,
          },
          tx,
        );
        return { user, token };
      });
    } catch (err) {
      // Concurrent registration of the same email: behave as "already exists".
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }
    await this.sendVerificationEmail(created.user, created.token);
  }

  async verifyEmail(rawToken: string, ctx: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const token = await this.consumeToken(rawToken, 'EMAIL_VERIFICATION', tx);
      await tx.user.updateMany({
        where: { id: token.userId, status: 'PENDING_VERIFICATION' },
        data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
      });
      await this.audit.record(
        {
          action: 'auth.email.verified',
          outcome: 'SUCCESS',
          actorType: 'USER',
          actorUserId: token.userId,
          targetType: 'user',
          targetId: token.userId,
          context: ctx,
        },
        tx,
      );
    });
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'PENDING_VERIFICATION') return;
    const allowed = await this.redis.set(
      `cooldown:verify-email:${user.id}`,
      '1',
      'EX',
      RESEND_COOLDOWN_SECONDS,
      'NX',
    );
    if (allowed !== 'OK') return;
    const token = await this.prisma.$transaction(async (tx) => {
      await this.invalidateTokens(user.id, 'EMAIL_VERIFICATION', tx);
      return this.createToken(user.id, 'EMAIL_VERIFICATION', EMAIL_VERIFICATION_TTL_MS, tx);
    });
    await this.sendVerificationEmail(user, token);
  }

  // ---------------------------------------------------------------- step-up

  /** Re-proves possession of the authenticator in this session (ADR-0015). */
  async stepUp(
    userId: string,
    sessionId: string,
    code: string,
    ctx: RequestContext,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaEnabledAt)
      throw new AppError(
        HttpStatus.CONFLICT,
        'MFA_NOT_ENABLED',
        'Enable two-factor authentication first',
      );
    const ok = await this.mfa.verifyAndConsume(user, code);
    await this.audit.recordSafe({
      action: 'auth.step_up',
      outcome: ok ? 'SUCCESS' : 'FAILURE',
      actorType: 'USER',
      actorUserId: userId,
      targetType: 'session',
      targetId: sessionId,
      context: ctx,
    });
    if (!ok) throw new AppError(HttpStatus.UNAUTHORIZED, 'MFA_INVALID', 'Invalid or reused code');
    await this.prisma.session.update({ where: { id: sessionId }, data: { stepUpAt: new Date() } });
  }

  // ---------------------------------------------------------- wallet sign-in

  /** Issues a single-use SIWE nonce (5 minutes). */
  async walletNonce(): Promise<{
    nonce: string;
    domain: string;
    uri: string;
    expiresInSeconds: number;
  }> {
    const nonce = randomToken(16)
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 24)
      .padEnd(16, '0');
    await this.redis.set(`siwe:nonce:${nonce}`, '1', 'EX', 300);
    const origin = new URL(this.config.WEB_ORIGIN);
    return { nonce, domain: origin.host, uri: origin.origin, expiresInSeconds: 300 };
  }

  /**
   * Sign-In with Ethereum (EIP-4361, ADR-0013). The signature proves control of
   * the address; the account is created on first sign-in. No email, password
   * or identity documents are involved.
   */
  async walletLogin(
    input: { message: string; signature: string; referralCode?: string },
    ctx: RequestContext,
  ): Promise<LoginOutcome> {
    const origin = new URL(this.config.WEB_ORIGIN);
    const result = verifySiwe(input.message, input.signature, {
      domain: origin.host,
      origin: origin.origin,
      now: new Date(),
      maxAgeMs: 10 * 60_000,
    });
    const fail = async (reason: string): Promise<never> => {
      await this.audit.recordSafe({
        action: 'auth.login',
        outcome: 'FAILURE',
        actorType: 'ANONYMOUS',
        context: ctx,
        metadata: { method: 'wallet', reason },
      });
      throw new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Wallet sign-in failed');
    };
    if (!result.ok) return fail(result.reason);
    // Single use: a captured message + signature cannot be replayed.
    const consumed = await this.redis.getdel(`siwe:nonce:${result.message.nonce}`);
    if (consumed === null) return fail('unknown_or_used_nonce');

    let user = await this.prisma.user.findUnique({ where: { walletAddress: result.address } });
    if (!user) {
      try {
        user = await this.prisma.$transaction(async (tx) => {
          // A referral code only counts when it creates the account; unknown codes are ignored.
          const referrer = input.referralCode
            ? await tx.referralCode.findUnique({ where: { code: input.referralCode } })
            : null;
          const created = await tx.user.create({
            data: {
              walletAddress: result.address,
              status: 'ACTIVE',
              referredByUserId: referrer?.userId ?? null,
            },
          });
          await this.rbac.assignDefaultRole(created.id, tx);
          await this.audit.record(
            {
              action: 'auth.wallet_account.created',
              outcome: 'SUCCESS',
              actorType: 'USER',
              actorUserId: created.id,
              targetType: 'user',
              targetId: created.id,
              context: ctx,
              metadata: {
                chainId: result.message.chainId,
                referredBy: referrer?.userId ?? null,
              },
            },
            tx,
          );
          return created;
        });
      } catch (err) {
        // Two first sign-ins raced: the other one created the account.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'))
          throw err;
        user = await this.prisma.user.findUniqueOrThrow({
          where: { walletAddress: result.address },
        });
      }
    }
    if (user.status !== 'ACTIVE') {
      await this.auditLoginFailure(user.id, ctx, `status_${user.status.toLowerCase()}`);
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_NOT_ACTIVE', 'This account is not active');
    }
    return this.completeLogin(user.id, ctx, 'wallet');
  }

  // ---------------------------------------------------------------- login

  async login(
    input: { email: string; password: string },
    ctx: RequestContext,
  ): Promise<LoginOutcome> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user) {
      await this.passwords.verifyAgainstDummy(input.password);
      await this.audit.recordSafe({
        action: 'auth.login',
        outcome: 'FAILURE',
        actorType: 'ANONYMOUS',
        context: ctx,
        metadata: { reason: 'unknown_account', emailHash: sha256Hex(input.email) },
      });
      throw this.invalidCredentials();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.auditLoginFailure(user.id, ctx, 'locked');
      throw new AppError(
        HttpStatus.FORBIDDEN,
        'ACCOUNT_LOCKED',
        'Too many failed attempts. Try again later or reset your password.',
      );
    }

    // Accounts without a password (wallet accounts that also have an email) cannot use it.
    const hash = user.passwordHash;
    const valid =
      hash === null
        ? (await this.passwords.verifyAgainstDummy(input.password), false)
        : await this.passwords.verify(hash, input.password);
    if (!valid) {
      await this.registerFailedAttempt(user.id);
      await this.auditLoginFailure(user.id, ctx, 'bad_password');
      throw this.invalidCredentials();
    }

    this.assertLoginAllowed(user);

    const updates: Prisma.UserUpdateInput = { failedLoginCount: 0, lockedUntil: null };
    if (hash !== null && this.passwords.needsRehash(hash)) {
      updates.passwordHash = await this.passwords.hash(input.password);
    }
    await this.prisma.user.update({ where: { id: user.id }, data: updates });

    if (user.mfaEnabledAt) {
      const challengeId = randomToken(32);
      const challenge: MfaChallenge = { userId: user.id, attempts: 0 };
      await this.redis.set(
        this.challengeKey(challengeId),
        JSON.stringify(challenge),
        'EX',
        MFA_CHALLENGE_TTL_SECONDS,
      );
      await this.audit.recordSafe({
        action: 'auth.login.mfa_challenge',
        outcome: 'SUCCESS',
        actorType: 'USER',
        actorUserId: user.id,
        context: ctx,
      });
      return {
        kind: 'mfa_required',
        result: {
          status: 'mfa_required',
          challengeId,
          expiresInSeconds: MFA_CHALLENGE_TTL_SECONDS,
        },
      };
    }

    return this.completeLogin(user.id, ctx, 'password');
  }

  async completeMfaLogin(
    challengeId: string,
    code: string,
    ctx: RequestContext,
  ): Promise<LoginOutcome> {
    const key = this.challengeKey(challengeId);
    const raw = await this.redis.get(key);
    if (!raw) {
      throw new AppError(
        HttpStatus.UNAUTHORIZED,
        'INVALID_TOKEN',
        'Sign-in challenge expired. Please sign in again.',
      );
    }
    const challenge = JSON.parse(raw) as MfaChallenge;

    const user = await this.prisma.user.findUnique({ where: { id: challenge.userId } });
    if (!user) {
      await this.redis.del(key);
      throw new AppError(
        HttpStatus.UNAUTHORIZED,
        'INVALID_TOKEN',
        'Sign-in challenge expired. Please sign in again.',
      );
    }
    this.assertLoginAllowed(user);

    const accepted = await this.mfa.verifyAndConsume(user, code);
    if (!accepted) {
      challenge.attempts += 1;
      if (challenge.attempts >= MFA_CHALLENGE_MAX_ATTEMPTS) {
        await this.redis.del(key);
      } else {
        await this.redis.set(key, JSON.stringify(challenge), 'KEEPTTL');
      }
      await this.registerFailedAttempt(user.id);
      await this.auditLoginFailure(user.id, ctx, 'bad_mfa_code');
      throw new AppError(HttpStatus.UNAUTHORIZED, 'MFA_INVALID', 'Invalid authentication code');
    }

    // Single use: a challenge cannot mint two sessions even under a race.
    const deleted = await this.redis.del(key);
    if (deleted !== 1) {
      throw new AppError(
        HttpStatus.UNAUTHORIZED,
        'INVALID_TOKEN',
        'Sign-in challenge expired. Please sign in again.',
      );
    }
    return this.completeLogin(user.id, ctx, 'password+totp');
  }

  async logout(sessionId: string, userId: string, ctx: RequestContext): Promise<void> {
    await this.sessions.revoke(sessionId, 'logout');
    await this.audit.recordSafe({
      action: 'auth.logout',
      outcome: 'SUCCESS',
      actorType: 'USER',
      actorUserId: userId,
      targetType: 'session',
      targetId: sessionId,
      context: ctx,
    });
  }

  // ---------------------------------------------------------------- passwords

  async forgotPassword(email: string, ctx: RequestContext): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status === 'CLOSED') return;
    const allowed = await this.redis.set(
      `cooldown:pw-reset:${user.id}`,
      '1',
      'EX',
      RESEND_COOLDOWN_SECONDS,
      'NX',
    );
    if (allowed !== 'OK') return;

    const token = await this.prisma.$transaction(async (tx) => {
      await this.invalidateTokens(user.id, 'PASSWORD_RESET', tx);
      const t = await this.createToken(user.id, 'PASSWORD_RESET', PASSWORD_RESET_TTL_MS, tx);
      await this.audit.record(
        {
          action: 'auth.password.reset_requested',
          outcome: 'SUCCESS',
          actorType: 'ANONYMOUS',
          targetType: 'user',
          targetId: user.id,
          context: ctx,
        },
        tx,
      );
      return t;
    });
    await this.mail.send({
      to: user.email!,
      kind: 'password_reset',
      subject: 'Reset your password',
      text:
        'Use the link below to choose a new password. It expires in 1 hour and can be used once.\n' +
        `${this.config.WEB_ORIGIN}/reset-password#token=${token}\n\n` +
        'If you did not request this, you can ignore this email; your password has not changed.',
    });
  }

  async resetPassword(rawToken: string, newPassword: string, ctx: RequestContext): Promise<void> {
    const passwordHash = await this.passwords.hash(newPassword);
    const user = await this.prisma.$transaction(async (tx) => {
      const token = await this.consumeToken(rawToken, 'PASSWORD_RESET', tx);
      const current = await tx.user.findUniqueOrThrow({ where: { id: token.userId } });
      // Completing a reset proves control of the mailbox, so it also verifies the email.
      const verify = current.status === 'PENDING_VERIFICATION';
      const updated = await tx.user.update({
        where: { id: token.userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
          ...(verify ? { status: 'ACTIVE' as const, emailVerifiedAt: new Date() } : {}),
        },
      });
      await this.sessions.revokeAllForUser(token.userId, 'password_reset', { tx });
      await this.audit.record(
        {
          action: 'auth.password.reset',
          outcome: 'SUCCESS',
          actorType: 'USER',
          actorUserId: token.userId,
          targetType: 'user',
          targetId: token.userId,
          context: ctx,
        },
        tx,
      );
      return updated;
    });
    await this.sendPasswordChangedNotice(user.email);
  }

  async changePassword(
    params: { userId: string; sessionId: string; currentPassword: string; newPassword: string },
    ctx: RequestContext,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: params.userId } });
    if (user.passwordHash === null)
      throw new AppError(
        HttpStatus.CONFLICT,
        'CONFLICT',
        'This account signs in with a wallet and has no password',
      );
    if (!(await this.passwords.verify(user.passwordHash, params.currentPassword))) {
      await this.audit.recordSafe({
        action: 'auth.password.change',
        outcome: 'FAILURE',
        actorType: 'USER',
        actorUserId: user.id,
        context: ctx,
        metadata: { reason: 'bad_current_password' },
      });
      throw this.invalidCredentials('Current password is incorrect');
    }
    const passwordHash = await this.passwords.hash(params.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, passwordChangedAt: new Date() },
      });
      await this.sessions.revokeAllForUser(user.id, 'password_changed', {
        exceptSessionId: params.sessionId,
        tx,
      });
      await this.audit.record(
        {
          action: 'auth.password.change',
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
    await this.sendPasswordChangedNotice(user.email);
  }

  // ---------------------------------------------------------------- helpers

  private async completeLogin(
    userId: string,
    ctx: RequestContext,
    method: string,
  ): Promise<LoginOutcome> {
    const { token, user } = await this.prisma.$transaction(async (tx) => {
      const created = await this.sessions.create(userId, ctx, tx);
      await this.audit.record(
        {
          action: 'auth.login',
          outcome: 'SUCCESS',
          actorType: 'USER',
          actorUserId: userId,
          targetType: 'session',
          targetId: created.session.id,
          context: ctx,
          metadata: { method },
        },
        tx,
      );
      const u = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      return { token: created.token, user: u };
    });
    const { roles, permissions } = await this.rbac.rolesAndPermissionsFor(userId);
    return {
      kind: 'authenticated',
      sessionToken: token,
      result: { status: 'authenticated', user: toCurrentUserDto(user, roles, permissions) },
    };
  }

  private assertLoginAllowed(user: User): void {
    if (user.status === 'PENDING_VERIFICATION') {
      throw new AppError(
        HttpStatus.FORBIDDEN,
        'EMAIL_NOT_VERIFIED',
        'Please verify your email address first',
      );
    }
    if (user.status !== 'ACTIVE') {
      throw new AppError(
        HttpStatus.FORBIDDEN,
        'ACCOUNT_NOT_ACTIVE',
        'This account is not active. Contact support.',
      );
    }
  }

  /** Atomic increment; locks the account once the threshold is reached. */
  private async registerFailedAttempt(userId: string): Promise<void> {
    const max = this.config.LOGIN_MAX_FAILED_ATTEMPTS;
    const lockMs = this.config.LOGIN_LOCKOUT_MINUTES * 60_000;
    await this.prisma.$executeRaw`
      UPDATE "users"
      SET "failed_login_count" = CASE WHEN "failed_login_count" + 1 >= ${max} THEN 0 ELSE "failed_login_count" + 1 END,
          "locked_until" = CASE WHEN "failed_login_count" + 1 >= ${max}
                                THEN now() + (${lockMs}::int * interval '1 millisecond')
                                ELSE "locked_until" END,
          "updated_at" = now()
      WHERE "id" = ${userId}::uuid`;
  }

  private auditLoginFailure(userId: string, ctx: RequestContext, reason: string): Promise<void> {
    return this.audit.recordSafe({
      action: 'auth.login',
      outcome: 'FAILURE',
      actorType: 'USER',
      actorUserId: userId,
      targetType: 'user',
      targetId: userId,
      context: ctx,
      metadata: { reason },
    });
  }

  private invalidCredentials(message = 'Invalid email or password'): AppError {
    return new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', message);
  }

  private challengeKey(challengeId: string): string {
    return `mfa:challenge:${sha256Hex(challengeId)}`;
  }

  private async createToken(
    userId: string,
    purpose: TokenPurpose,
    ttlMs: number,
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const token = randomToken(32);
    await tx.verificationToken.create({
      data: {
        userId,
        purpose,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
    return token;
  }

  private async invalidateTokens(
    userId: string,
    purpose: TokenPurpose,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.verificationToken.updateMany({
      where: { userId, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }

  /** Consumes a single-use token atomically (conditional update guards against double use). */
  private async consumeToken(
    rawToken: string,
    purpose: TokenPurpose,
    tx: Prisma.TransactionClient,
  ) {
    const invalid = new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_TOKEN',
      'This link is invalid or has expired',
    );
    const token = await tx.verificationToken.findUnique({
      where: { tokenHash: sha256Hex(rawToken) },
    });
    if (
      !token ||
      token.purpose !== purpose ||
      token.consumedAt ||
      token.expiresAt.getTime() <= Date.now()
    ) {
      throw invalid;
    }
    const result = await tx.verificationToken.updateMany({
      where: { id: token.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (result.count !== 1) throw invalid;
    return token;
  }

  private sendVerificationEmail(user: User, token: string): Promise<void> {
    return this.mail.send({
      to: user.email!,
      kind: 'email_verification',
      subject: 'Verify your email address',
      text:
        'Confirm your email address to activate your account. The link expires in 24 hours.\n' +
        `${this.config.WEB_ORIGIN}/verify-email#token=${token}`,
    });
  }

  private async sendPasswordChangedNotice(email: string | null): Promise<void> {
    if (email === null) return;
    return this.mail.send({
      to: email,
      kind: 'security_notice',
      subject: 'Your password was changed',
      text:
        'The password for your account was just changed and other sessions were signed out.\n' +
        'If this was not you, reset your password immediately and contact support.',
    });
  }
}
