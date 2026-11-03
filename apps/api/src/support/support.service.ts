import { HttpStatus, Injectable } from '@nestjs/common';
import type { SupportMessage, SupportTicket } from '@prisma/client';
import type { AnnouncementDto, TicketDto } from '@platform/shared';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

const MAX_OPEN_TICKETS = 10;

type TicketRow = SupportTicket & { messages?: SupportMessage[]; user?: { email: string } };

/** Support tickets (messages are append-only) and announcements (ADR-0012). */
@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private dto(t: TicketRow): TicketDto {
    return {
      id: t.id,
      subject: t.subject,
      status: t.status.toLowerCase() as TicketDto['status'],
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      ...(t.user ? { userEmail: t.user.email } : {}),
      ...(t.messages
        ? {
            messages: t.messages.map((m) => ({
              id: m.id,
              fromStaff: m.fromStaff,
              body: m.body,
              createdAt: m.createdAt.toISOString(),
            })),
          }
        : {}),
    };
  }

  async create(userId: string, subject: string, body: string): Promise<TicketDto> {
    const open = await this.prisma.supportTicket.count({
      where: { userId, status: { not: 'CLOSED' } },
    });
    if (open >= MAX_OPEN_TICKETS)
      throw new AppError(HttpStatus.CONFLICT, 'LIMIT_EXCEEDED', 'Too many open tickets');
    const id = randomUUID();
    const ticket = await this.prisma.supportTicket.create({
      data: {
        id,
        userId,
        subject,
        messages: { create: { id: randomUUID(), authorId: userId, fromStaff: false, body } },
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    return this.dto(ticket);
  }

  async listOwn(userId: string): Promise<TicketDto[]> {
    const rows = await this.prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    return rows.map((t) => this.dto(t));
  }

  private async load(id: string): Promise<TicketRow> {
    const t = await this.prisma.supportTicket.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } }, user: { select: { email: true } } },
    });
    if (!t) throw AppError.notFound('Ticket not found');
    return t;
  }

  async getOwn(userId: string, id: string): Promise<TicketDto> {
    const t = await this.load(id);
    if (t.userId !== userId) throw AppError.notFound('Ticket not found'); // no existence leak
    const { user: _user, ...rest } = t;
    void _user;
    return this.dto(rest);
  }

  async reply(
    ticketId: string,
    authorId: string,
    body: string,
    fromStaff: boolean,
  ): Promise<TicketDto> {
    const t = await this.load(ticketId);
    if (!fromStaff && t.userId !== authorId) throw AppError.notFound('Ticket not found');
    if (fromStaff && t.userId === authorId)
      throw AppError.forbidden('Staff cannot answer their own tickets');
    if (t.status === 'CLOSED')
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'Ticket is closed; open a new one');
    await this.prisma.$transaction(async (tx) => {
      await tx.supportMessage.create({
        data: { id: randomUUID(), ticketId, authorId, fromStaff, body },
      });
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { status: fromStaff ? 'WAITING_ON_USER' : 'OPEN' },
      });
      if (fromStaff) {
        await this.notifications.notify(
          {
            userId: t.userId,
            kind: 'support.reply',
            title: 'Support replied to your ticket',
            body: t.subject,
            data: { ticketId },
          },
          tx,
        );
        await this.audit.record(
          {
            action: 'support.ticket.replied',
            outcome: 'SUCCESS',
            actorType: 'STAFF',
            actorUserId: authorId,
            targetType: 'support_ticket',
            targetId: ticketId,
          },
          tx,
        );
      }
    });
    return fromStaff ? this.dto(await this.load(ticketId)) : this.getOwn(authorId, ticketId);
  }

  async close(ticketId: string, staffId: string): Promise<TicketDto> {
    await this.load(ticketId);
    await this.prisma.supportTicket.update({ where: { id: ticketId }, data: { status: 'CLOSED' } });
    await this.audit.record({
      action: 'support.ticket.closed',
      outcome: 'SUCCESS',
      actorType: 'STAFF',
      actorUserId: staffId,
      targetType: 'support_ticket',
      targetId: ticketId,
    });
    return this.dto(await this.load(ticketId));
  }

  async queue(status: 'open' | 'all', limit: number): Promise<TicketDto[]> {
    const rows = await this.prisma.supportTicket.findMany({
      where: status === 'open' ? { status: { not: 'CLOSED' } } : {},
      include: { user: { select: { email: true } } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    return rows.map((t) => this.dto(t));
  }

  async staffView(id: string): Promise<TicketDto> {
    return this.dto(await this.load(id));
  }

  // ------------------------------------------------------------ announcements

  async announce(title: string, body: string, staffId: string): Promise<AnnouncementDto> {
    const a = await this.prisma.announcement.create({
      data: { id: randomUUID(), title, body, createdById: staffId },
    });
    await this.audit.record({
      action: 'announcement.published',
      outcome: 'SUCCESS',
      actorType: 'STAFF',
      actorUserId: staffId,
      targetType: 'announcement',
      targetId: a.id,
      metadata: { title },
    });
    return { id: a.id, title: a.title, body: a.body, publishedAt: a.publishedAt.toISOString() };
  }

  async announcements(limit: number): Promise<AnnouncementDto[]> {
    const rows = await this.prisma.announcement.findMany({
      orderBy: { publishedAt: 'desc' },
      take: limit,
    });
    return rows.map((a) => ({
      id: a.id,
      title: a.title,
      body: a.body,
      publishedAt: a.publishedAt.toISOString(),
    }));
  }
}
