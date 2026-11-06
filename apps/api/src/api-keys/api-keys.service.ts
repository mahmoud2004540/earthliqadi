import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ApiKey } from '@prisma/client';
import {
  CUSTOMER_PERMISSIONS,
  PERMISSIONS,
  type ApiKeyChallengeDto,
  type ApiKeyDto,
  type ApiKeyScope,
  type Permission,
} from '@platform/shared';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { recoverPersonalSigner } from '../auth/siwe';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { REDIS } from '../infrastructure/redis/redis.module';
import { RbacService } from '../rbac/rbac.service';
import { randomToken } from '../security/crypto';
import { authorizationMessage, canonicalRequest, ipAllowed, verifyEd25519 } from './api-key-auth';

/** Maximum clock difference between client and server for signed requests. */
export const API_KEY_SKEW_MS = 30_000;
const MAX_ACTIVE_KEYS = 10;
const CHALLENGE_TTL_SECONDS = 300;

/** Permissions an API key can carry: never account management, never staff. */
const SCOPE_PERMISSIONS: Record<ApiKeyScope, Permission[]> = {
  read: [PERMISSIONS.ACCOUNT_SELF_READ],
  trade: [PERMISSIONS.ACCOUNT_SELF_READ, PERMISSIONS.TRADING_TRADE],
};

interface Challenge {
  userId: string;
  address: string;
  publicKey: string;
  label: string;
  scopes: ApiKeyScope[];
  allowedIps: string[];
  expiresAt: string;
  message: string;
}

export interface SignedRequest {
  keyId: string;
  timestamp: string;
  signature: string;
  method: string;
  pathWithQuery: string;
  body: string;
  ip: string | undefined;
}

function keyError(message: string): AppError {
  return new AppError(HttpStatus.UNAUTHORIZED, 'API_KEY_INVALID', message);
}

/**
 * Agent API keys (ADR-0017). A key is authorised by a wallet signature over
 * a server-built message that states its scopes and expiry; requests are
 * signed with the key's Ed25519 private key, which never reaches the server.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  toDto(k: ApiKey): ApiKeyDto {
    return {
      id: k.id,
      label: k.label,
      publicKey: k.publicKey,
      scopes: k.scopes as ApiKeyScope[],
      allowedIps: k.allowedIps,
      createdAt: k.createdAt.toISOString(),
      expiresAt: k.expiresAt.toISOString(),
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
    };
  }

  async list(userId: string): Promise<ApiKeyDto[]> {
    const keys = await this.prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return keys.map((k) => this.toDto(k));
  }

  /** Step 1: builds the message the wallet must sign (single use, 5 minutes). */
  async challenge(
    auth: AuthContext,
    input: {
      label: string;
      publicKey: string;
      scopes: ApiKeyScope[];
      allowedIps: string[];
      expiresInDays: number;
    },
  ): Promise<ApiKeyChallengeDto> {
    const address = auth.user.walletAddress;
    if (!address)
      throw AppError.forbidden(
        'API keys are for wallet accounts (authorised by a wallet signature)',
      );
    const active = await this.prisma.apiKey.count({
      where: { userId: auth.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (active >= MAX_ACTIVE_KEYS)
      throw new AppError(
        HttpStatus.CONFLICT,
        'LIMIT_EXCEEDED',
        `At most ${MAX_ACTIVE_KEYS} active API keys; revoke one first`,
      );
    if (await this.prisma.apiKey.findUnique({ where: { publicKey: input.publicKey } }))
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'This public key is already registered');
    const scopes = [...new Set(input.scopes)].sort();
    const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
    const challengeId = randomToken(18)
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 24)
      .padEnd(16, '0');
    const message = authorizationMessage({
      domain: new URL(this.config.WEB_ORIGIN).host,
      address,
      publicKey: input.publicKey,
      label: input.label,
      scopes,
      allowedIps: input.allowedIps,
      expiresAt,
      nonce: challengeId,
    });
    const value: Challenge = {
      userId: auth.user.id,
      address,
      publicKey: input.publicKey,
      label: input.label,
      scopes,
      allowedIps: input.allowedIps,
      expiresAt: expiresAt.toISOString(),
      message,
    };
    await this.redis.set(
      `apikey:challenge:${challengeId}`,
      JSON.stringify(value),
      'EX',
      CHALLENGE_TTL_SECONDS,
    );
    return { challengeId, message, expiresInSeconds: CHALLENGE_TTL_SECONDS };
  }

  /** Step 2: verifies the wallet signature and registers the key. */
  async create(
    auth: AuthContext,
    input: { challengeId: string; signature: string },
    ctx: RequestContext,
  ): Promise<ApiKeyDto> {
    const raw = await this.redis.getdel(`apikey:challenge:${input.challengeId}`);
    if (!raw) throw keyError('Unknown or expired challenge');
    const c = JSON.parse(raw) as Challenge;
    if (c.userId !== auth.user.id) throw keyError('Unknown or expired challenge');
    const signer = recoverPersonalSigner(c.message, input.signature);
    if (!signer || signer.toLowerCase() !== c.address.toLowerCase()) {
      await this.audit.recordSafe({
        action: 'apikey.authorize',
        outcome: 'FAILURE',
        actorType: 'USER',
        actorUserId: auth.user.id,
        context: ctx,
        metadata: { reason: 'bad_signature' },
      });
      throw keyError('The signature does not come from this account’s wallet');
    }
    const key = await this.prisma.$transaction(async (tx) => {
      const created = await tx.apiKey.create({
        data: {
          id: randomUUID(),
          userId: c.userId,
          label: c.label,
          publicKey: c.publicKey,
          scopes: c.scopes,
          allowedIps: c.allowedIps,
          authorizationMessage: c.message,
          authorizationSignature: input.signature,
          expiresAt: new Date(c.expiresAt),
        },
      });
      await this.audit.record(
        {
          action: 'apikey.created',
          outcome: 'SUCCESS',
          actorType: 'USER',
          actorUserId: c.userId,
          targetType: 'api_key',
          targetId: created.id,
          context: ctx,
          metadata: { scopes: c.scopes, allowedIps: c.allowedIps, expiresAt: c.expiresAt },
        },
        tx,
      );
      return created;
    });
    return this.toDto(key);
  }

  async revoke(userId: string, id: string, ctx: RequestContext): Promise<ApiKeyDto> {
    const key = await this.prisma.apiKey.findFirst({ where: { id, userId } });
    if (!key) throw AppError.notFound('API key not found');
    if (key.revokedAt) return this.toDto(key);
    const updated = await this.prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    await this.audit.recordSafe({
      action: 'apikey.revoked',
      outcome: 'SUCCESS',
      actorType: 'USER',
      actorUserId: userId,
      targetType: 'api_key',
      targetId: id,
      context: ctx,
    });
    return this.toDto(updated);
  }

  /**
   * Verifies a signed request and returns the auth context it may act with:
   * the key's scopes intersected with the owner's customer permissions.
   * Fails closed on every check; replays of a signature are rejected.
   */
  async authenticate(
    req: SignedRequest,
    now = Date.now(),
  ): Promise<{ auth: AuthContext; scopes: ApiKeyScope[] }> {
    if (!/^[0-9a-f-]{36}$/.test(req.keyId)) throw keyError('Malformed API key id');
    const ts = Number(req.timestamp);
    if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > API_KEY_SKEW_MS)
      throw keyError('Request timestamp is missing or outside the allowed clock skew');
    const key = await this.prisma.apiKey.findUnique({
      where: { id: req.keyId },
      include: { user: true },
    });
    if (!key || key.revokedAt || key.expiresAt.getTime() <= now)
      throw keyError('Unknown, revoked or expired API key');
    const message = canonicalRequest(req.timestamp, req.method, req.pathWithQuery, req.body);
    if (!verifyEd25519(key.publicKey, message, req.signature)) throw keyError('Bad signature');
    if (!ipAllowed(key.allowedIps, req.ip))
      throw new AppError(
        HttpStatus.FORBIDDEN,
        'IP_NOT_ALLOWED',
        'This key is not allowed from this network',
      );
    // Single use per signature within the skew window (both directions).
    const fresh = await this.redis.set(
      `apikey:sig:${req.signature}`,
      '1',
      'PX',
      2 * API_KEY_SKEW_MS,
      'NX',
    );
    if (fresh !== 'OK') throw keyError('Replayed request');
    const u = key.user;
    if (u.status !== 'ACTIVE')
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_NOT_ACTIVE', 'Account is not active');
    const { roles, permissions } = await this.rbac.rolesAndPermissionsFor(u.id);
    const scopes = key.scopes as ApiKeyScope[];
    const allowed = new Set(scopes.flatMap((s) => SCOPE_PERMISSIONS[s]));
    // last_used_at is informational; at most one write per minute per key.
    if (!key.lastUsedAt || now - key.lastUsedAt.getTime() > 60_000)
      await this.prisma.apiKey.update({
        where: { id: key.id },
        data: { lastUsedAt: new Date(now) },
      });
    return {
      scopes,
      auth: {
        sessionId: `apikey:${key.id}`,
        stepUpAt: null,
        user: {
          id: u.id,
          email: u.email,
          walletAddress: u.walletAddress,
          status: u.status,
          accountType: u.accountType,
          emailVerifiedAt: u.emailVerifiedAt,
          mfaEnabledAt: u.mfaEnabledAt,
          createdAt: u.createdAt,
        },
        roles,
        permissions: permissions.filter((p) => allowed.has(p) && CUSTOMER_PERMISSIONS.includes(p)),
      },
    };
  }
}
