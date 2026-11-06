import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type ListingRequest } from '@prisma/client';
import type {
  ListingRequestDto,
  ListingStatus,
  createListingSchema,
  listingDecisionSchema,
} from '@platform/shared';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../infrastructure/prisma/prisma.service';

/** Live requests per author; more must wait for a decision or be withdrawn. */
export const MAX_LIVE_REQUESTS = 3;
const LIVE = ['OPEN', 'REVIEW'];

function conflict(message: string): AppError {
  return new AppError(HttpStatus.CONFLICT, 'CONFLICT', message);
}

/**
 * Listing request board (ADR-0026). Anyone with an account can request a
 * market and vote once per request. Only votes from accounts that had
 * traded rank the board, so fresh wallets cannot stuff it. The decision
 * stays with staff and the published criteria, and every decision is
 * public, explained and audited.
 */
@Injectable()
export class ListingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Requests and votes come from main accounts; sub-accounts and vaults answer to them. */
  private async mainAccount(userId: string): Promise<void> {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { parentUserId: true },
    });
    if (u.parentUserId) throw AppError.forbidden('Use your main account');
  }

  /** Whether the account (with its sub-accounts) has ever traded. */
  async hasTraded(userId: string): Promise<boolean> {
    const subs = await this.prisma.user.findMany({
      where: { parentUserId: userId },
      select: { id: true },
    });
    const ids = [userId, ...subs.map((s) => s.id)];
    const t = await this.prisma.trade.findFirst({
      where: { OR: [{ buyerUserId: { in: ids } }, { sellerUserId: { in: ids } }] },
      select: { id: true },
    });
    return t !== null;
  }

  async create(
    userId: string,
    input: z.infer<typeof createListingSchema>,
    ctx: RequestContext,
  ): Promise<ListingRequestDto> {
    await this.mainAccount(userId);
    const kind = input.kind === 'spot' ? 'SPOT' : 'PERPETUAL';
    const quote = await this.prisma.asset.findUnique({ where: { code: input.quoteAsset } });
    if (!quote)
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Unknown quote asset', [
        { path: 'quoteAsset', message: 'Choose an asset that exists on the platform' },
      ]);
    const existing = await this.prisma.market.findFirst({
      where: { kind, baseAsset: { code: input.baseSymbol }, quoteAsset: { code: quote.code } },
      select: { symbol: true },
    });
    if (existing) throw conflict(`${existing.symbol} is already listed`);
    const live = await this.prisma.listingRequest.count({
      where: { authorUserId: userId, status: { in: LIVE } },
    });
    if (live >= MAX_LIVE_REQUESTS)
      throw new AppError(
        HttpStatus.CONFLICT,
        'LIMIT_EXCEEDED',
        `At most ${MAX_LIVE_REQUESTS} open requests per account`,
      );
    const id = randomUUID();
    const eligible = await this.hasTraded(userId);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.listingRequest.create({
          data: {
            id,
            authorUserId: userId,
            baseSymbol: input.baseSymbol,
            baseName: input.baseName,
            kind,
            quoteAssetCode: quote.code,
            chainId: input.chainId ?? null,
            tokenAddress: input.tokenAddress ?? null,
            rationale: input.rationale,
            link: input.link ?? null,
          },
        });
        // The author's own vote.
        await tx.listingVote.create({ data: { requestId: id, userId, eligible } });
        await this.audit.record(
          {
            action: 'listing.requested',
            outcome: 'SUCCESS',
            actorType: 'USER',
            actorUserId: userId,
            targetType: 'listing_request',
            targetId: id,
            context: ctx,
            metadata: { baseSymbol: input.baseSymbol, kind, quote: quote.code },
          },
          tx,
        );
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw conflict('An open request for this market already exists: vote for it instead');
      throw err;
    }
    return this.get(id, userId);
  }

  async vote(userId: string, id: string): Promise<ListingRequestDto> {
    await this.mainAccount(userId);
    const r = await this.prisma.listingRequest.findUnique({ where: { id } });
    if (!r) throw AppError.notFound('Listing request not found');
    if (!LIVE.includes(r.status)) throw conflict('Voting is closed for this request');
    const eligible = await this.hasTraded(userId);
    await this.prisma.listingVote.upsert({
      where: { requestId_userId: { requestId: id, userId } },
      create: { requestId: id, userId, eligible },
      update: {},
    });
    return this.get(id, userId);
  }

  async unvote(userId: string, id: string): Promise<ListingRequestDto> {
    const r = await this.prisma.listingRequest.findUnique({ where: { id } });
    if (!r) throw AppError.notFound('Listing request not found');
    if (!LIVE.includes(r.status)) throw conflict('Voting is closed for this request');
    await this.prisma.listingVote.deleteMany({ where: { requestId: id, userId } });
    return this.get(id, userId);
  }

  async withdraw(userId: string, id: string, ctx: RequestContext): Promise<ListingRequestDto> {
    const r = await this.prisma.listingRequest.updateMany({
      where: { id, authorUserId: userId, status: 'OPEN' },
      data: { status: 'WITHDRAWN', updatedAt: new Date() },
    });
    if (r.count === 0) throw conflict('Only your own open requests can be withdrawn');
    await this.audit.recordSafe({
      action: 'listing.withdrawn',
      outcome: 'SUCCESS',
      actorType: 'USER',
      actorUserId: userId,
      targetType: 'listing_request',
      targetId: id,
      context: ctx,
    });
    return this.get(id, userId);
  }

  /** Staff decision: under review, listed (naming the market) or rejected, always explained. */
  async decide(
    staffId: string,
    id: string,
    input: z.infer<typeof listingDecisionSchema>,
    ctx: RequestContext,
  ): Promise<ListingRequestDto> {
    const r = await this.prisma.listingRequest.findUnique({ where: { id } });
    if (!r) throw AppError.notFound('Listing request not found');
    const allowed: Record<string, string[]> = {
      review: ['OPEN'],
      listed: LIVE,
      rejected: LIVE,
    };
    if (!allowed[input.status]!.includes(r.status))
      throw conflict(`A ${r.status.toLowerCase()} request cannot move to ${input.status}`);
    let marketId: string | null = null;
    if (input.status === 'listed') {
      const m = await this.prisma.market.findUnique({
        where: { symbol: input.market! },
        include: { baseAsset: true, quoteAsset: true },
      });
      if (
        !m ||
        m.kind !== r.kind ||
        m.baseAsset.code !== r.baseSymbol ||
        m.quoteAsset.code !== r.quoteAssetCode
      )
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_FAILED',
          'Name an existing market with the requested base, quote and kind',
          [{ path: 'market', message: 'No matching market' }],
        );
      marketId = m.id;
    }
    const final = input.status !== 'review';
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const done = await tx.listingRequest.updateMany({
        where: { id, status: r.status },
        data: {
          status: input.status.toUpperCase(),
          updatedAt: now,
          ...(final
            ? { decisionNote: input.note!, decidedBy: staffId, decidedAt: now, marketId }
            : {}),
        },
      });
      if (done.count === 0) throw conflict('The request changed; reload and try again');
      await this.audit.record(
        {
          action: 'listing.decided',
          outcome: 'SUCCESS',
          actorType: 'STAFF',
          actorUserId: staffId,
          targetType: 'listing_request',
          targetId: id,
          context: ctx,
          metadata: {
            from: r.status,
            to: input.status,
            note: input.note ?? null,
            market: input.market ?? null,
          },
        },
        tx,
      );
    });
    return this.get(id);
  }

  // ------------------------------------------------------------ reads

  async list(status?: ListingStatus): Promise<ListingRequestDto[]> {
    const rows = await this.prisma.listingRequest.findMany({
      where: status ? { status: status.toUpperCase() } : { status: { not: 'WITHDRAWN' } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const dtos = await this.toDtos(rows);
    const live = (d: ListingRequestDto) => d.status === 'open' || d.status === 'review';
    // Live requests by eligible votes; decided ones by decision date.
    return dtos.sort((a, b) =>
      live(a) !== live(b)
        ? live(a)
          ? -1
          : 1
        : live(a)
          ? b.eligibleVotes - a.eligibleVotes || b.totalVotes - a.totalVotes
          : (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt),
    );
  }

  async get(id: string, viewerId?: string): Promise<ListingRequestDto> {
    const r = await this.prisma.listingRequest.findUnique({ where: { id } });
    if (!r) throw AppError.notFound('Listing request not found');
    const [dto] = await this.toDtos([r]);
    if (!viewerId) return dto!;
    const voted = await this.prisma.listingVote.findUnique({
      where: { requestId_userId: { requestId: id, userId: viewerId } },
    });
    return { ...dto!, mine: r.authorUserId === viewerId, votedByMe: voted !== null };
  }

  /** The viewer's own requests and votes, to mark them on the public board. */
  async mine(userId: string): Promise<{ authored: string[]; voted: string[] }> {
    const [authored, voted] = await Promise.all([
      this.prisma.listingRequest.findMany({
        where: { authorUserId: userId },
        select: { id: true },
      }),
      this.prisma.listingVote.findMany({ where: { userId }, select: { requestId: true } }),
    ]);
    return { authored: authored.map((r) => r.id), voted: voted.map((v) => v.requestId) };
  }

  private async toDtos(rows: ListingRequest[]): Promise<ListingRequestDto[]> {
    const ids = rows.map((r) => r.id);
    const counts = await this.prisma.listingVote.groupBy({
      by: ['requestId', 'eligible'],
      where: { requestId: { in: ids } },
      _count: true,
    });
    const markets = await this.prisma.market.findMany({
      where: { id: { in: rows.map((r) => r.marketId).filter((m): m is string => m !== null) } },
      select: { id: true, symbol: true },
    });
    const symbol = new Map(markets.map((m) => [m.id, m.symbol]));
    return rows.map((r) => {
      const c = counts.filter((x) => x.requestId === r.id);
      return {
        id: r.id,
        baseSymbol: r.baseSymbol,
        baseName: r.baseName,
        kind: r.kind === 'SPOT' ? 'spot' : 'perpetual',
        quoteAsset: r.quoteAssetCode,
        chainId: r.chainId,
        tokenAddress: r.tokenAddress,
        rationale: r.rationale,
        link: r.link,
        status: r.status.toLowerCase() as ListingStatus,
        eligibleVotes: c.filter((x) => x.eligible).reduce((s, x) => s + x._count, 0),
        totalVotes: c.reduce((s, x) => s + x._count, 0),
        decisionNote: r.decisionNote,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        market: r.marketId ? (symbol.get(r.marketId) ?? null) : null,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }
}
