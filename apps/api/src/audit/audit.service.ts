import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type ActorType, type AuditOutcome } from '@prisma/client';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../infrastructure/prisma/prisma.service';

export interface AuditEvent {
  action: string;
  outcome: AuditOutcome;
  actorType: ActorType;
  actorUserId?: string | null;
  targetType?: string;
  targetId?: string;
  context?: Partial<RequestContext>;
  /** Non-sensitive context only. Keys that look sensitive are stripped defensively. */
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEY = /pass|secret|token|code|otp|key|cookie|authorization/i;

export function scrubMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : value;
  }
  return out;
}

/**
 * Writes to the append-only audit log. Security-relevant actions should call
 * `record` inside the same transaction as the change they describe (pass `tx`)
 * so the change and its audit trail commit or roll back together.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(event: AuditEvent, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        action: event.action,
        outcome: event.outcome,
        actorType: event.actorType,
        actorUserId: event.actorUserId ?? null,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        ipAddress: event.context?.ipAddress ?? null,
        userAgent: event.context?.userAgent ?? null,
        requestId: event.context?.requestId ?? null,
        metadata: scrubMetadata(event.metadata) as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * For failure events outside a transaction: an audit write failure must not
   * mask the original error returned to the client, but it is logged loudly.
   */
  async recordSafe(event: AuditEvent): Promise<void> {
    try {
      await this.record(event);
    } catch (err) {
      this.logger.error({ err, action: event.action }, 'Failed to write audit log entry');
    }
  }
}
