import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { LeaderVault, Prisma } from '@prisma/client';
import { formatAmountTrimmed, parseAmount } from '@platform/shared';
import { createHash, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { toMinorUnits } from '../ledger/ledger-domain';
import { LedgerService } from '../ledger/ledger.service';
import { parsePerpConfig } from '../perps/perp-config';
import { unrealizedPnl } from '../perps/perp-math';
import { positionState } from '../perps/perp-orders';
import { currentMark } from '../perps/perp-prices';
import { RbacService } from '../rbac/rbac.service';
import { unitsOf } from '../trading/markets.service';
import {
  E18,
  blendedHwm,
  drawdownBps,
  leaderShareBps,
  ppsE18,
  redeem,
  sharesForDeposit,
} from './vault-math';

/** Vault margin in use (holds + position margin) may not exceed this share of equity. */
export const MAX_MARGIN_USAGE_BPS = 8000n;

export interface VaultEquity {
  equity: bigint;
  available: bigint;
  inUse: bigint;
  /** False when a position has no reliable mark: deposits and payouts wait. */
  priced: boolean;
}

type Db = Prisma.TransactionClient | PrismaService;

function conflict(message: string): AppError {
  return new AppError(HttpStatus.CONFLICT, 'CONFLICT', message);
}
function invalid(message: string): AppError {
  return new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', message);
}

/**
 * Leader vaults (ADR-0019). A leader trades pooled collateral on perpetual
 * markets of the vault's quote asset. Followers hold shares priced at equity
 * (balances + unrealised PnL at mark). The leader can never move vault funds:
 * money leaves only through redemptions, paid to the share holder, with the
 * profit share (above each holder's high-water mark) paid to the leader.
 */
@Injectable()
export class LeaderVaultsService {
  private readonly logger = new Logger(LeaderVaultsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
  ) {}

  async require(id: string): Promise<LeaderVault> {
    const v = await this.prisma.leaderVault.findUnique({ where: { id } });
    if (!v) throw AppError.notFound('Vault not found');
    return v;
  }

  /** Equity in the quote asset's minor units: balances plus unrealised PnL at mark. */
  async equity(v: LeaderVault, db: Db = this.prisma): Promise<VaultEquity> {
    const accounts = await db.ledgerAccount.findMany({
      where: {
        ownerUserId: v.accountUserId,
        assetId: v.quoteAssetId,
        type: { in: ['USER_AVAILABLE', 'USER_LOCKED', 'USER_MARGIN'] },
      },
    });
    const bal = (t: string) => toMinorUnits(accounts.find((a) => a.type === t)?.balance ?? '0');
    const available = bal('USER_AVAILABLE');
    const inUse = bal('USER_LOCKED') + bal('USER_MARGIN');
    let unrealized = 0n;
    let priced = true;
    const positions = await db.position.findMany({
      where: { userId: v.accountUserId, sizeLots: { not: 0n } },
      include: { market: { include: { baseAsset: true, quoteAsset: true } } },
    });
    for (const p of positions) {
      const mark = await currentMark(db, p.marketId, parsePerpConfig(p.market.perpConfig));
      if (mark === null) {
        priced = false;
        continue;
      }
      unrealized += unrealizedPnl(positionState(p), mark, unitsOf(p.market));
    }
    return { equity: available + inUse + unrealized, available, inUse, priced };
  }

  private async totals(vaultId: string, db: Db) {
    const [held, pending] = await Promise.all([
      db.vaultShare.aggregate({ where: { vaultId }, _sum: { shares: true } }),
      db.vaultRedemption.aggregate({
        where: { vaultId, status: 'PENDING' },
        _sum: { shares: true },
      }),
    ]);
    return {
      total: toMinorUnits(held._sum.shares ?? '0') + toMinorUnits(pending._sum.shares ?? '0'),
      pending: toMinorUnits(pending._sum.shares ?? '0'),
    };
  }

  private async leaderShares(v: LeaderVault, db: Db): Promise<bigint> {
    const s = await db.vaultShare.findUnique({
      where: { vaultId_userId: { vaultId: v.id, userId: v.leaderUserId } },
    });
    return s ? toMinorUnits(s.shares) : 0n;
  }

  private async requireWalletAccount(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!u.walletAddress || u.parentUserId || u.isVault)
      throw AppError.forbidden(
        'Vault shares are held by wallet accounts (so they are claimable on-chain)',
      );
    return u;
  }

  // ----------------------------------------------------------- lifecycle

  async create(
    leaderId: string,
    input: {
      name: string;
      description: string;
      asset: string;
      profitShareBps: number;
      maxLeverage: number;
      maxDrawdownBps: number;
      initialDeposit: string;
    },
    ctx: RequestContext,
  ): Promise<LeaderVault> {
    await this.requireWalletAccount(leaderId);
    const asset = await this.ledger.requireAsset(input.asset);
    this.amount(input.initialDeposit, asset.scale); // validate before creating anything
    const id = randomUUID();
    const vault = await this.prisma
      .$transaction(async (tx) => {
        const account = await tx.user.create({
          data: {
            parentUserId: leaderId,
            label: `vault:${input.name}`,
            status: 'ACTIVE',
            isVault: true,
          },
        });
        await this.rbac.assignDefaultRole(account.id, tx);
        const v = await tx.leaderVault.create({
          data: {
            id,
            leaderUserId: leaderId,
            accountUserId: account.id,
            name: input.name,
            description: input.description,
            quoteAssetId: asset.id,
            profitShareBps: input.profitShareBps,
            maxLeverage: input.maxLeverage,
            maxDrawdownBps: input.maxDrawdownBps,
            peakPpsE18: E18.toString(),
          },
        });
        await this.audit.record(
          {
            action: 'vault.created',
            outcome: 'SUCCESS',
            actorType: 'USER',
            actorUserId: leaderId,
            targetType: 'leader_vault',
            targetId: id,
            context: ctx,
            metadata: { ...input },
          },
          tx,
        );
        return v;
      })
      .catch((err: unknown) => {
        if (
          (err as { code?: string }).code === 'P2002' ||
          /leader_vaults_name_key/.test(String(err))
        )
          throw conflict('A vault with this name already exists');
        throw err;
      });
    await this.deposit(leaderId, vault.id, input.initialDeposit, 'create', ctx);
    return vault;
  }

  private amount(value: string, scale: number): bigint {
    let a: bigint;
    try {
      a = parseAmount(value, scale);
    } catch (err) {
      throw invalid((err as Error).message);
    }
    if (a <= 0n) throw invalid('Amount must be positive');
    return a;
  }

  /** Deposits collateral for shares at the current price per share. */
  async deposit(
    userId: string,
    vaultId: string,
    amountText: string,
    idempotencyKey: string,
    ctx: RequestContext,
  ): Promise<{ shares: string; ppsE18: string }> {
    const v = await this.require(vaultId);
    if (v.status !== 'OPEN') throw conflict('This vault is not accepting deposits right now');
    await this.requireWalletAccount(userId);
    const asset = await this.prisma.asset.findUniqueOrThrow({ where: { id: v.quoteAssetId } });
    const amount = this.amount(amountText, asset.scale);
    const key = `vault-deposit:${createHash('sha256').update(`${vaultId}|${userId}|${idempotencyKey}`).digest('hex')}`;
    if (await this.prisma.journalEntry.findUnique({ where: { idempotencyKey: key } }))
      throw conflict('This deposit was already made');

    return this.prisma.$transaction(
      async (tx) => {
        // One vault at a time: serialise share changes on the vault row.
        await tx.$queryRaw`SELECT 1 FROM "leader_vaults" WHERE "id" = ${vaultId}::uuid FOR UPDATE`;
        const eq = await this.equity(v, tx);
        if (!eq.priced) throw conflict('No reliable mark price right now; try again shortly');
        const { total } = await this.totals(vaultId, tx);
        const minted = sharesForDeposit(amount, eq.equity, total);
        if (minted <= 0n) throw invalid('Deposit too small for one share');
        const pps = ppsE18(eq.equity, total);
        const isLeader = userId === v.leaderUserId;
        const leader = await this.leaderShares(v, tx);
        if (!isLeader && total > 0n) {
          const share = leaderShareBps(leader, total + minted);
          if (share < BigInt(v.minLeaderShareBps))
            throw conflict(
              `The leader must keep at least ${v.minLeaderShareBps / 100}% of the vault; this deposit would exceed the vault's capacity`,
            );
        }
        const src = await this.ledger.accountId(v.quoteAssetId, 'USER_AVAILABLE', userId);
        const dst = await this.ledger.accountId(v.quoteAssetId, 'USER_AVAILABLE', v.accountUserId);
        await this.ledger.postWithin(
          tx,
          {
            type: 'VAULT_DEPOSIT',
            idempotencyKey: key,
            description: `Deposit into vault ${v.name}`,
            postings: [
              { accountId: src, direction: 'DEBIT', amount },
              { accountId: dst, direction: 'CREDIT', amount },
            ],
          },
          { actorType: 'USER', actorUserId: userId, requestId: ctx.requestId },
        );
        const existing = await tx.vaultShare.findUnique({
          where: { vaultId_userId: { vaultId, userId } },
        });
        const oldShares = existing ? toMinorUnits(existing.shares) : 0n;
        const hwm = blendedHwm(
          oldShares,
          existing ? toMinorUnits(existing.hwmE18) : pps,
          minted,
          pps,
        );
        await tx.vaultShare.upsert({
          where: { vaultId_userId: { vaultId, userId } },
          create: { vaultId, userId, shares: minted.toString(), hwmE18: hwm.toString() },
          update: {
            shares: (oldShares + minted).toString(),
            hwmE18: hwm.toString(),
            updatedAt: new Date(),
          },
        });
        await this.audit.record(
          {
            action: 'vault.deposit',
            outcome: 'SUCCESS',
            actorType: 'USER',
            actorUserId: userId,
            targetType: 'leader_vault',
            targetId: vaultId,
            context: ctx,
            metadata: { amount: amount.toString(), shares: minted.toString() },
          },
          tx,
        );
        return { shares: minted.toString(), ppsE18: pps.toString() };
      },
      { timeout: 30_000 },
    );
  }

  /**
   * Requests a redemption. It is paid at once when free collateral allows,
   * otherwise it is queued: the vault can then only reduce risk until it is paid.
   */
  async requestRedemption(
    userId: string,
    vaultId: string,
    sharesText: string, // a share count or 'all'
    ctx: RequestContext,
  ): Promise<{ id: string; status: string }> {
    const v = await this.require(vaultId);
    const id = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "leader_vaults" WHERE "id" = ${vaultId}::uuid FOR UPDATE`;
      const holding = await tx.vaultShare.findUnique({
        where: { vaultId_userId: { vaultId, userId } },
      });
      const held = holding ? toMinorUnits(holding.shares) : 0n;
      const shares = sharesText === 'all' ? held : BigInt(sharesText);
      if (shares <= 0n || shares > held) throw invalid('Not enough shares');
      if (userId === v.leaderUserId) {
        const { total } = await this.totals(vaultId, tx);
        const othersHold = total - held > 0n;
        if (othersHold && leaderShareBps(held - shares, total) < BigInt(v.minLeaderShareBps))
          throw conflict(
            `While others hold shares, the leader must keep at least ${v.minLeaderShareBps / 100}%`,
          );
      }
      await tx.vaultShare.update({
        where: { vaultId_userId: { vaultId, userId } },
        data: { shares: (held - shares).toString(), updatedAt: new Date() },
      });
      await tx.vaultRedemption.create({
        data: { id, vaultId, userId, shares: shares.toString() },
      });
      await this.audit.record(
        {
          action: 'vault.redemption.requested',
          outcome: 'SUCCESS',
          actorType: 'USER',
          actorUserId: userId,
          targetType: 'leader_vault',
          targetId: vaultId,
          context: ctx,
          metadata: { redemptionId: id, shares: shares.toString() },
        },
        tx,
      );
    });
    await this.payPending(vaultId);
    const r = await this.prisma.vaultRedemption.findUniqueOrThrow({ where: { id } });
    return { id, status: r.status === 'PAID' ? 'paid' : 'pending' };
  }

  /** Pays queued redemptions in request order while free collateral allows. */
  async payPending(vaultId: string): Promise<number> {
    const v = await this.require(vaultId);
    let paid = 0;
    for (;;) {
      const done = await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "leader_vaults" WHERE "id" = ${vaultId}::uuid FOR UPDATE`;
          const next = await tx.vaultRedemption.findFirst({
            where: { vaultId, status: 'PENDING' },
            orderBy: { requestedAt: 'asc' },
          });
          if (!next) return false;
          const eq = await this.equity(v, tx);
          if (!eq.priced) return false;
          const { total } = await this.totals(vaultId, tx);
          const shares = toMinorUnits(next.shares);
          const holding = await tx.vaultShare.findUnique({
            where: { vaultId_userId: { vaultId, userId: next.userId } },
          });
          const r = redeem(
            shares,
            eq.equity,
            total,
            holding ? toMinorUnits(holding.hwmE18) : E18,
            v.profitShareBps,
            next.userId === v.leaderUserId,
          );
          if (r.gross > eq.available) return false; // wait for the leader to free collateral
          const from = await this.ledger.accountId(
            v.quoteAssetId,
            'USER_AVAILABLE',
            v.accountUserId,
          );
          const postings: { accountId: string; direction: 'DEBIT' | 'CREDIT'; amount: bigint }[] = [
            { accountId: from, direction: 'DEBIT', amount: r.gross },
          ];
          if (r.net > 0n)
            postings.push({
              accountId: await this.ledger.accountId(v.quoteAssetId, 'USER_AVAILABLE', next.userId),
              direction: 'CREDIT',
              amount: r.net,
            });
          if (r.profitShare > 0n)
            postings.push({
              accountId: await this.ledger.accountId(
                v.quoteAssetId,
                'USER_AVAILABLE',
                v.leaderUserId,
              ),
              direction: 'CREDIT',
              amount: r.profitShare,
            });
          if (r.gross > 0n)
            await this.ledger.postWithin(
              tx,
              {
                type: 'VAULT_REDEMPTION',
                idempotencyKey: `vault-redemption:${next.id}`,
                description: `Redemption from vault ${v.name}`,
                postings,
              },
              { actorType: 'SYSTEM', requestId: `vault:${vaultId}` },
            );
          await tx.vaultRedemption.update({
            where: { id: next.id },
            data: {
              status: 'PAID',
              amount: r.net.toString(),
              profitShare: r.profitShare.toString(),
              paidAt: new Date(),
            },
          });
          if (holding)
            await tx.vaultShare.update({
              where: { vaultId_userId: { vaultId, userId: next.userId } },
              data: { hwmE18: r.hwmE18.toString() },
            });
          return true;
        },
        { timeout: 30_000 },
      );
      if (!done) return paid;
      paid++;
    }
  }

  // --------------------------------------------------------------- rules

  /**
   * Order rules for a vault's trading account, checked at order entry:
   * perpetuals of the vault's asset only; leverage within the vault limit;
   * only risk-reducing orders while halted or while redemptions wait; total
   * margin in use within MAX_MARGIN_USAGE_BPS of equity.
   */
  async checkOrder(
    accountUserId: string,
    market: { id: string; kind: string; quoteAssetId: string },
    reduceOnly: boolean,
    leverage: number,
    newHold: bigint,
  ): Promise<void> {
    const v = await this.prisma.leaderVault.findUnique({ where: { accountUserId } });
    if (!v) return;
    if (market.kind !== 'PERPETUAL' || market.quoteAssetId !== v.quoteAssetId)
      throw AppError.forbidden('A vault trades perpetual markets of its own collateral asset only');
    if (reduceOnly) return;
    if (v.status !== 'OPEN')
      throw conflict('The vault is halted (drawdown limit): only reduce-only orders are accepted');
    const { pending } = await this.totals(v.id, this.prisma);
    if (pending > 0n)
      throw conflict('Redemptions are waiting: only reduce-only orders until they are paid');
    if (leverage > v.maxLeverage)
      throw conflict(`The vault's maximum leverage is ${v.maxLeverage}x`);
    const eq = await this.equity(v);
    if ((eq.inUse + newHold) * 10_000n > MAX_MARGIN_USAGE_BPS * (eq.equity > 0n ? eq.equity : 0n))
      throw conflict('A vault may not use more than 80% of its equity as margin');
  }

  // ----------------------------------------------------------------- job

  /** Records equity and price per share, applies the drawdown halt, pays queued exits. */
  async tick(now = new Date()): Promise<void> {
    for (const v of await this.prisma.leaderVault.findMany({
      where: { status: { not: 'CLOSED' } },
    })) {
      try {
        const eq = await this.equity(v);
        if (!eq.priced) continue;
        const { total } = await this.totals(v.id, this.prisma);
        if (total === 0n) continue;
        const pps = ppsE18(eq.equity, total);
        const peak = toMinorUnits(v.peakPpsE18) > pps ? toMinorUnits(v.peakPpsE18) : pps;
        const halted = drawdownBps(peak, pps) > BigInt(v.maxDrawdownBps);
        await this.prisma.leaderVault.update({
          where: { id: v.id },
          data: { peakPpsE18: peak.toString(), status: halted ? 'HALTED' : 'OPEN' },
        });
        if (halted !== (v.status === 'HALTED'))
          await this.audit.recordSafe({
            action: halted ? 'vault.halted' : 'vault.resumed',
            outcome: 'SUCCESS',
            actorType: 'SYSTEM',
            targetType: 'leader_vault',
            targetId: v.id,
            context: { requestId: 'vault-tick' },
            metadata: { ppsE18: pps.toString(), peakE18: peak.toString() },
          });
        await this.prisma.vaultSnapshot.upsert({
          where: { vaultId_at: { vaultId: v.id, at: now } },
          create: {
            vaultId: v.id,
            at: now,
            equity: eq.equity.toString(),
            totalShares: total.toString(),
            ppsE18: pps.toString(),
          },
          update: {},
        });
        await this.payPending(v.id);
      } catch (err) {
        this.logger.error({ err, vault: v.id }, 'Vault tick failed');
      }
    }
  }

  // ------------------------------------------------------------- reading

  async summary(v: LeaderVault) {
    const asset = await this.prisma.asset.findUniqueOrThrow({ where: { id: v.quoteAssetId } });
    const eq = await this.equity(v);
    const { total, pending } = await this.totals(v.id, this.prisma);
    const holders = await this.prisma.vaultShare.count({
      where: { vaultId: v.id, shares: { gt: 0 } },
    });
    const leader = await this.prisma.user.findUniqueOrThrow({ where: { id: v.leaderUserId } });
    const snaps = await this.prisma.vaultSnapshot.findMany({
      where: { vaultId: v.id },
      orderBy: { at: 'asc' },
      take: 5000,
    });
    const pps = ppsE18(eq.equity, total);
    let peak = E18;
    let maxDd = 0n;
    for (const s of snaps) {
      const p = toMinorUnits(s.ppsE18);
      if (p > peak) peak = p;
      const dd = drawdownBps(peak, p);
      if (dd > maxDd) maxDd = dd;
    }
    const monthAgo = Date.now() - 30 * 86_400_000;
    const base30 = snaps.find((s) => s.at.getTime() >= monthAgo);
    const ret = (from: bigint) => ((pps - from) * 10_000n) / from; // bps
    return {
      id: v.id,
      name: v.name,
      description: v.description,
      leader: leader.walletAddress
        ? `${leader.walletAddress.slice(0, 6)}…${leader.walletAddress.slice(-4)}`
        : 'leader',
      asset: asset.code,
      status: v.status.toLowerCase(),
      profitShareBps: v.profitShareBps,
      minLeaderShareBps: v.minLeaderShareBps,
      maxLeverage: v.maxLeverage,
      maxDrawdownBps: v.maxDrawdownBps,
      equity: formatAmountTrimmed(eq.equity > 0n ? eq.equity : 0n, asset.scale),
      sharePrice: formatAmountTrimmed(pps / 10n ** 12n, 6),
      holders,
      pendingShares: pending.toString(),
      returnSinceInceptionBps: Number(ret(E18)),
      return30dBps: base30 ? Number(ret(toMinorUnits(base30.ppsE18))) : null,
      maxDrawdownSeenBps: Number(maxDd),
      createdAt: v.createdAt.toISOString(),
      curve: snaps
        .filter((_, i) => i % Math.max(1, Math.ceil(snaps.length / 200)) === 0)
        .map((s) => ({
          at: s.at.toISOString(),
          sharePrice: formatAmountTrimmed(toMinorUnits(s.ppsE18) / 10n ** 12n, 6),
        })),
    };
  }

  /** Public list, ranked by return over max drawdown (min 1%), not raw return. */
  async leaderboard() {
    const vaults = await this.prisma.leaderVault.findMany({ where: { status: { not: 'CLOSED' } } });
    const out: Awaited<ReturnType<LeaderVaultsService['summary']>>[] = [];
    for (const v of vaults) out.push(await this.summary(v));
    const score = (s: (typeof out)[number]) =>
      s.returnSinceInceptionBps / Math.max(100, s.maxDrawdownSeenBps);
    return out
      .map(({ curve: _curve, ...rest }) => ({
        ...rest,
        score: Number(score({ ...rest, curve: [] }).toFixed(3)),
      }))
      .sort((a, b) => b.score - a.score);
  }

  async position(userId: string, v: LeaderVault) {
    const s = await this.prisma.vaultShare.findUnique({
      where: { vaultId_userId: { vaultId: v.id, userId } },
    });
    const pending = await this.prisma.vaultRedemption.findMany({
      where: { vaultId: v.id, userId, status: 'PENDING' },
    });
    const eq = await this.equity(v);
    const { total } = await this.totals(v.id, this.prisma);
    const shares = s ? toMinorUnits(s.shares) : 0n;
    const asset = await this.prisma.asset.findUniqueOrThrow({ where: { id: v.quoteAssetId } });
    return {
      shares: shares.toString(),
      value: formatAmountTrimmed(
        total > 0n && eq.equity > 0n ? (shares * eq.equity) / total : 0n,
        asset.scale,
      ),
      pendingRedemptions: pending.map((p) => ({ id: p.id, shares: p.shares.toString() })),
    };
  }
}
