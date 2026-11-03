import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, Session } from '@prisma/client';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { randomToken, sha256Hex } from '../security/crypto';

/** Avoid a DB write on every request: refresh lastSeenAt at most this often. */
const TOUCH_INTERVAL_MS = 60_000;

const sessionUserSelect = {
  id: true,
  email: true,
  status: true,
  accountType: true,
  emailVerifiedAt: true,
  mfaEnabledAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export type SessionUser = Prisma.UserGetPayload<{ select: typeof sessionUserSelect }>;

/**
 * Server-side sessions with opaque tokens. Only the SHA-256 of a token is
 * stored, so a database read does not yield usable sessions. Sessions have an
 * absolute lifetime and an idle timeout and can be revoked individually.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(
    userId: string,
    ctx: RequestContext,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<{ token: string; session: Session }> {
    const token = randomToken(32);
    const session = await tx.session.create({
      data: {
        userId,
        tokenHash: sha256Hex(token),
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        expiresAt: new Date(Date.now() + this.config.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600_000),
      },
    });
    return { token, session };
  }

  /** Returns the live session and its user, or null. Expired sessions are revoked lazily. */
  async validate(token: string): Promise<{ session: Session; user: SessionUser } | null> {
    if (!token || token.length > 128) return null;
    const found = await this.prisma.session.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: { select: sessionUserSelect } },
    });
    if (!found || found.revokedAt) return null;

    const now = Date.now();
    const idleDeadline =
      found.lastSeenAt.getTime() + this.config.SESSION_IDLE_TIMEOUT_MINUTES * 60_000;
    if (found.expiresAt.getTime() <= now || idleDeadline <= now) {
      await this.revoke(found.id, found.expiresAt.getTime() <= now ? 'expired' : 'idle_timeout');
      return null;
    }
    if (found.user.status !== 'ACTIVE') {
      await this.revoke(found.id, 'account_not_active');
      return null;
    }

    if (now - found.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.session.update({
        where: { id: found.id },
        data: { lastSeenAt: new Date(now) },
      });
    }
    const { user, ...session } = found;
    return { session, user };
  }

  async revoke(
    sessionId: string,
    reason: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Revoke a session only if it belongs to `userId` (prevents IDOR). Returns whether one was revoked. */
  async revokeOwned(userId: string, sessionId: string, reason: string): Promise<boolean> {
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count > 0;
  }

  async revokeAllForUser(
    userId: string,
    reason: string,
    options: { exceptSessionId?: string; tx?: Prisma.TransactionClient } = {},
  ): Promise<number> {
    const result = await (options.tx ?? this.prisma).session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  listActive(userId: string): Promise<Session[]> {
    const idleCutoff = new Date(Date.now() - this.config.SESSION_IDLE_TIMEOUT_MINUTES * 60_000);
    return this.prisma.session.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        lastSeenAt: { gt: idleCutoff },
      },
      orderBy: { lastSeenAt: 'desc' },
      take: 100,
    });
  }
}
