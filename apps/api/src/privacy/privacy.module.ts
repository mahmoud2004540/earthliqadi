import { Controller, Get, Header, Injectable, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, formatAmountTrimmed } from '@platform/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { AuthRateLimit, RequirePermissions } from '../common/decorators';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ComplianceModule } from '../compliance/compliance.module';
import { KycService } from '../compliance/kyc.service';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { toMinorUnits } from '../ledger/ledger-domain';
import { LedgerModule } from '../ledger/ledger.module';
import { LedgerService } from '../ledger/ledger.service';

/**
 * Personal data export (GDPR art. 15/20; ADR-0015). Everything the platform
 * holds about the requesting account, in one machine-readable JSON document.
 * Secrets (password hash, TOTP seed, session tokens) are never included.
 */
@Injectable()
export class DataExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly kyc: KycService,
  ) {}

  async export(userId: string) {
    const p = this.prisma;
    const user = await p.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        walletAddress: true,
        status: true,
        accountType: true,
        emailVerifiedAt: true,
        mfaEnabledAt: true,
        kycLevel: true,
        createdAt: true,
        roles: { select: { role: { select: { key: true } }, grantedAt: true } },
      },
    });
    const [
      sessions,
      postings,
      orders,
      trades,
      positions,
      withdrawals,
      deposits,
      tickets,
      notifications,
      actions,
    ] = await Promise.all([
      p.session.findMany({
        where: { userId },
        select: {
          createdAt: true,
          lastSeenAt: true,
          expiresAt: true,
          revokedAt: true,
          revokedReason: true,
          ipAddress: true,
          userAgent: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      p.posting.findMany({
        where: { account: { ownerUserId: userId } },
        include: {
          entry: { select: { type: true, description: true } },
          account: { select: { type: true } },
          asset: { select: { code: true, scale: true } },
        },
        orderBy: { id: 'asc' },
      }),
      p.order.findMany({
        where: { userId },
        include: { market: { select: { symbol: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      p.trade.findMany({
        where: { OR: [{ buyerUserId: userId }, { sellerUserId: userId }] },
        include: { market: { select: { symbol: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      p.position.findMany({ where: { userId }, include: { market: { select: { symbol: true } } } }),
      p.withdrawal.findMany({
        where: { userId },
        include: { asset: { select: { code: true, scale: true } } },
      }),
      p.chainDeposit.findMany({
        where: { userId },
        include: { asset: { select: { code: true, scale: true } } },
      }),
      p.supportTicket.findMany({
        where: { userId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      }),
      p.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      p.auditLog.findMany({
        where: { actorUserId: userId },
        select: { action: true, outcome: true, occurredAt: true, ipAddress: true, userAgent: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    const amt = (v: { toFixed(d?: number): string }, scale: number) =>
      formatAmountTrimmed(toMinorUnits(v), scale);
    return {
      format: 'exchange-platform/personal-data-export@1',
      generatedAt: new Date().toISOString(),
      account: {
        ...user,
        roles: user.roles.map((r) => ({ role: r.role.key, grantedAt: r.grantedAt })),
      },
      sessions,
      balances: await this.ledger.balancesForUser(userId),
      ledgerPostings: postings.map((x) => ({
        entryId: x.entryId.toString(),
        entryType: x.entry.type,
        description: x.entry.description,
        account: x.account.type,
        asset: x.asset.code,
        direction: x.direction,
        amount: amt(x.amount, x.asset.scale),
        at: x.createdAt,
      })),
      orders: orders.map((o) => ({
        id: o.id,
        market: o.market.symbol,
        side: o.side,
        type: o.type,
        status: o.status,
        priceTicks: o.priceTicks?.toString() ?? null,
        quantityLots: o.quantityLots.toString(),
        filledLots: o.filledLots.toString(),
        createdAt: o.createdAt,
      })),
      trades: trades.map((t) => ({
        id: t.id,
        market: t.market.symbol,
        side: t.buyerUserId === userId ? 'buy' : 'sell',
        priceTicks: t.priceTicks.toString(),
        quantityLots: t.quantityLots.toString(),
        executedAt: t.executedAt,
      })),
      positions: positions.map((x) => ({
        market: x.market.symbol,
        sizeLots: x.sizeLots.toString(),
        margin: x.margin.toString(),
        realizedPnl: x.realizedPnl.toString(),
        fundingPnl: x.fundingPnl.toString(),
      })),
      vault: {
        deposits: deposits.map((d) => ({
          depositId: d.depositId.toString(),
          asset: d.asset.code,
          amount: amt(d.amount, d.asset.scale),
          txHash: d.txHash,
          at: d.createdAt,
        })),
        withdrawals: withdrawals.map((w) => ({
          id: w.id,
          asset: w.asset.code,
          amount: amt(w.amount, w.asset.scale),
          status: w.status,
          txHash: w.txHash,
          at: w.createdAt,
        })),
      },
      identityVerification: await this.kyc.exportForUser(userId),
      supportTickets: tickets.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        createdAt: t.createdAt,
        messages: t.messages.map((m) => ({
          fromStaff: m.fromStaff,
          body: m.body,
          at: m.createdAt,
        })),
      })),
      notifications: notifications.map((n) => ({
        kind: n.kind,
        title: n.title,
        body: n.body,
        read: n.readAt !== null,
        at: n.createdAt,
      })),
      activityLog: actions,
      retentionNote:
        'Ledger, trade and audit records are kept for the legally required retention period and cannot be erased on request; other data can be deleted on request through support.',
    };
  }
}

@ApiTags('account')
@Controller({ path: 'me', version: '1' })
export class DataExportController {
  constructor(
    private readonly exports: DataExportService,
    private readonly audit: AuditService,
  ) {}

  @Get('export')
  @AuthRateLimit()
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  @Header('Content-Disposition', 'attachment; filename="personal-data-export.json"')
  @Header('Cache-Control', 'no-store')
  async export(@CurrentAuth() auth: AuthContext, @ReqContext() ctx: RequestContext) {
    const data = await this.exports.export(auth.user.id);
    await this.audit.record({
      action: 'account.data_exported',
      outcome: 'SUCCESS',
      actorType: 'USER',
      actorUserId: auth.user.id,
      targetType: 'user',
      targetId: auth.user.id,
      context: ctx,
    });
    return data;
  }
}

@Module({
  imports: [ComplianceModule, LedgerModule],
  controllers: [DataExportController],
  providers: [DataExportService],
})
export class PrivacyModule {}
