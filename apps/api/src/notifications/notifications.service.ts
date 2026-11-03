import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { NotificationDto } from '@platform/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../infrastructure/prisma/prisma.service';

/** In-app notifications (ADR-0012). Email/push delivery comes with a real provider. */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates a notification, inside the caller's transaction when one is given. */
  async notify(
    input: {
      userId: string;
      kind: string;
      title: string;
      body: string;
      data?: Record<string, string>;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await (tx ?? this.prisma).notification.create({
      data: {
        id: randomUUID(),
        userId: input.userId,
        kind: input.kind,
        title: input.title.slice(0, 160),
        body: input.body.slice(0, 1000),
        data: input.data ?? {},
      },
    });
  }

  async list(userId: string, limit: number): Promise<{ items: NotificationDto[]; unread: number }> {
    const [rows, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return {
      unread,
      items: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        data: n.data as Record<string, string>,
        read: n.readAt !== null,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  }

  async markRead(userId: string, ids: string[] | 'all'): Promise<number> {
    const r = await this.prisma.notification.updateMany({
      where: { userId, readAt: null, ...(ids === 'all' ? {} : { id: { in: ids } }) },
      data: { readAt: new Date() },
    });
    return r.count;
  }
}
