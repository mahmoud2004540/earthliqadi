import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type {
  FeeScheduleDto,
  MyFeesDto,
  PointsEntryDto,
  ReferralSummaryDto,
} from '@platform/shared';
import { formatAmountTrimmed, parseAmount } from '@platform/shared';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { toMinorUnits } from '../ledger/ledger-domain';
import { tierForVolume } from './fee-math';

/** Normalised volume unit: 6 decimals (1 000 000 = 1 unit of a USD-like quote asset). */
const VOLUME_SCALE = 6;
/** A pair of accounts is treated as wash trading when, on one day, each sends
 * at least this share of its volume to the other and their flows net out. */
const WASH_SHARE_BPS = 5000n;
const WASH_NETTING_BPS = 8000n;

function shortAccount(wallet: string | null, id: string): string {
  return wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : `account ${id.slice(0, 8)}`;
}

/**
 * Fee tiers, referrals and activity points (ADR-0018). Tiers and points are
 * recomputed from settled trades by a job; every number is derived from the
 * trade history, never entered by hand.
 */
@Injectable()
export class GrowthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** SQL filter for the quote assets whose notional counts as volume. */
  private volumeAssetCodes(): Promise<string[]> {
    if (this.config.FEE_VOLUME_QUOTE_ASSETS.length > 0)
      return Promise.resolve(this.config.FEE_VOLUME_QUOTE_ASSETS);
    return this.prisma.asset
      .findMany({ where: { code: { contains: 'USD' }, isPaper: false }, select: { code: true } })
      .then((r) => r.map((a) => a.code));
  }

  // ------------------------------------------------------------------ job

  /** Recomputes 30-day tiers and the points of today and yesterday (UTC). Idempotent. */
  async recompute(now = new Date()): Promise<{ tiers: number; pointRows: number }> {
    const codes = await this.volumeAssetCodes();
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const volumes = await this.prisma.$queryRaw<{ user_id: string; volume: string }[]>`
      WITH t AS (
        SELECT tr."buyer_user_id", tr."seller_user_id",
               trunc(tr."quote_amount" * power(10::numeric, ${VOLUME_SCALE} - a."scale")) AS v
          FROM "trades" tr JOIN "markets" m ON m."id" = tr."market_id"
          JOIN "assets" a ON a."id" = m."quote_asset_id"
         WHERE tr."executed_at" >= ${since} AND a."code" = ANY(${codes}::text[]))
      SELECT u AS "user_id", SUM(v)::text AS "volume" FROM (
        SELECT "buyer_user_id" AS u, v FROM t UNION ALL SELECT "seller_user_id", v FROM t) x
      GROUP BY u`;
    const tiers = (await this.prisma.feeTier.findMany()).map((t) => ({
      ...t,
      minVolume: toMinorUnits(t.minVolume),
    }));
    const seen = new Set<string>();
    for (const v of volumes) {
      seen.add(v.user_id);
      const volume = BigInt(v.volume);
      const tier = tierForVolume(tiers, volume)?.tier ?? 0;
      await this.prisma.userFeeTier.upsert({
        where: { userId: v.user_id },
        create: { userId: v.user_id, tier, volume30d: volume.toString(), computedAt: now },
        update: { tier, volume30d: volume.toString(), computedAt: now },
      });
    }
    // Accounts without volume in the window fall back to tier 0.
    await this.prisma.userFeeTier.updateMany({
      where: { userId: { notIn: [...seen] } },
      data: { tier: 0, volume30d: '0', computedAt: now },
    });

    let pointRows = 0;
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    for (const day of [new Date(today.getTime() - 86_400_000), today]) {
      pointRows += await this.pointsForDay(day, codes, now);
    }
    return { tiers: volumes.length, pointRows };
  }

  /**
   * Points for one UTC day: 1 per unit of taker volume, 2 per unit of maker
   * volume. Excluded: trades between linked accounts (a parent and its
   * sub-accounts) and pairs whose flows mostly go to each other and net out.
   */
  private async pointsForDay(day: Date, codes: string[], now: Date): Promise<number> {
    const end = new Date(day.getTime() + 86_400_000);
    const rows = await this.prisma.$queryRaw<
      { buyer: string; seller: string; taker_side: string; v: string; linked: boolean }[]
    >`
      SELECT tr."buyer_user_id" AS "buyer", tr."seller_user_id" AS "seller",
             tr."taker_side"::text AS "taker_side",
             trunc(tr."quote_amount" * power(10::numeric, ${VOLUME_SCALE} - a."scale"))::text AS "v",
             COALESCE(b."parent_user_id", b."id") = COALESCE(s."parent_user_id", s."id") AS "linked"
        FROM "trades" tr JOIN "markets" m ON m."id" = tr."market_id"
        JOIN "assets" a ON a."id" = m."quote_asset_id"
        JOIN "users" b ON b."id" = tr."buyer_user_id"
        JOIN "users" s ON s."id" = tr."seller_user_id"
       WHERE tr."executed_at" >= ${day} AND tr."executed_at" < ${end}
         AND a."code" = ANY(${codes}::text[])`;
    const total = new Map<string, bigint>();
    const pair = new Map<string, { ab: bigint; ba: bigint }>(); // a<b; ab = a bought from b
    for (const r of rows) {
      const v = BigInt(r.v);
      for (const u of [r.buyer, r.seller]) total.set(u, (total.get(u) ?? 0n) + v);
      const [a, b] = r.buyer < r.seller ? [r.buyer, r.seller] : [r.seller, r.buyer];
      const p = pair.get(`${a}|${b}`) ?? { ab: 0n, ba: 0n };
      if (r.buyer === a) p.ab += v;
      else p.ba += v;
      pair.set(`${a}|${b}`, p);
    }
    const washPairs = new Set<string>();
    for (const [k, p] of pair) {
      const [a, b] = k.split('|') as [string, string];
      const both = p.ab + p.ba;
      const small = p.ab < p.ba ? p.ab : p.ba;
      const big = p.ab < p.ba ? p.ba : p.ab;
      const concentrated =
        both * 10_000n >= WASH_SHARE_BPS * (total.get(a) ?? 0n) &&
        both * 10_000n >= WASH_SHARE_BPS * (total.get(b) ?? 0n);
      if (concentrated && big > 0n && small * 10_000n >= WASH_NETTING_BPS * big) washPairs.add(k);
    }
    const points = new Map<string, { pts: bigint; excluded: bigint }>();
    const add = (u: string, pts: bigint, excluded: bigint) => {
      const cur = points.get(u) ?? { pts: 0n, excluded: 0n };
      points.set(u, { pts: cur.pts + pts, excluded: cur.excluded + excluded });
    };
    const unit = 10n ** BigInt(VOLUME_SCALE);
    for (const r of rows) {
      const v = BigInt(r.v);
      const [a, b] = r.buyer < r.seller ? [r.buyer, r.seller] : [r.seller, r.buyer];
      const excluded = r.linked || washPairs.has(`${a}|${b}`);
      const taker = r.taker_side === 'BUY' ? r.buyer : r.seller;
      const maker = taker === r.buyer ? r.seller : r.buyer;
      if (excluded) {
        add(taker, 0n, v);
        add(maker, 0n, v);
      } else {
        add(taker, v / unit, 0n);
        add(maker, (2n * v) / unit, 0n);
      }
    }
    for (const [userId, p] of points) {
      await this.prisma.userPoints.upsert({
        where: { userId_day: { userId, day } },
        create: {
          userId,
          day,
          points: p.pts.toString(),
          excludedVolume: p.excluded.toString(),
          computedAt: now,
        },
        update: {
          points: p.pts.toString(),
          excludedVolume: p.excluded.toString(),
          computedAt: now,
        },
      });
    }
    return points.size;
  }

  // ------------------------------------------------------------- reading

  async schedule(): Promise<FeeScheduleDto> {
    const tiers = await this.prisma.feeTier.findMany({ orderBy: { tier: 'asc' } });
    return {
      volumeAssets:
        this.config.FEE_VOLUME_QUOTE_ASSETS.join(', ') ||
        'every quote asset whose code contains USD',
      tiers: tiers.map((t) => ({
        tier: t.tier,
        minVolume30d: formatAmountTrimmed(toMinorUnits(t.minVolume), VOLUME_SCALE),
        takerDiscountBps: t.takerDiscountBps,
        makerDiscountBps: t.makerDiscountBps,
      })),
      referralShareBps: this.config.REFERRAL_FEE_SHARE_BPS,
      referralDurationDays: this.config.REFERRAL_DURATION_DAYS,
      notes: [
        'Discounts apply to each market’s published base fees. A negative effective maker fee is a rebate.',
        'Rebates and referral shares are paid only out of the taker fee of the same trade.',
        'Tiers are recomputed from settled trades at least hourly.',
      ],
    };
  }

  /** Replaces the published schedule (staff, step-up, audited). Tiers must strictly increase. */
  async replaceSchedule(
    tiers: {
      tier: number;
      minVolume30d: string;
      takerDiscountBps: number;
      makerDiscountBps: number;
    }[],
    actorUserId: string,
    ctx: RequestContext,
  ): Promise<FeeScheduleDto> {
    const sorted = [...tiers].sort((a, b) => a.tier - b.tier);
    const rows = sorted.map((t) => ({
      tier: t.tier,
      minVolume: parseAmount(t.minVolume30d, VOLUME_SCALE),
      takerDiscountBps: t.takerDiscountBps,
      makerDiscountBps: t.makerDiscountBps,
    }));
    const bad = (m: string) => new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', m);
    if (
      rows[0]?.tier !== 0 ||
      rows[0].minVolume !== 0n ||
      rows[0].takerDiscountBps !== 0 ||
      rows[0].makerDiscountBps !== 0
    )
      throw bad('Tier 0 must exist with zero volume and no discount');
    for (let i = 1; i < rows.length; i++) {
      const [a, b] = [rows[i - 1]!, rows[i]!];
      if (b.tier !== a.tier + 1 || b.minVolume <= a.minVolume)
        throw bad('Tiers must be consecutive with strictly increasing volume');
      if (b.takerDiscountBps < a.takerDiscountBps || b.makerDiscountBps < a.makerDiscountBps)
        throw bad('Discounts may not decrease for higher tiers');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.feeTier.deleteMany({});
      await tx.feeTier.createMany({
        data: rows.map((r) => ({ ...r, minVolume: r.minVolume.toString() })),
      });
      await tx.userFeeTier.updateMany({
        where: { tier: { gt: rows[rows.length - 1]!.tier } },
        data: { tier: rows[rows.length - 1]!.tier },
      });
      await this.audit.record(
        {
          action: 'fees.schedule.replaced',
          outcome: 'SUCCESS',
          actorType: 'STAFF',
          actorUserId,
          targetType: 'fee_schedule',
          targetId: 'global',
          context: ctx,
          metadata: { tiers },
        },
        tx,
      );
    });
    return this.schedule();
  }

  async myFees(userId: string): Promise<MyFeesDto> {
    const row = await this.prisma.userFeeTier.findUnique({ where: { userId } });
    const tier = await this.prisma.feeTier.findUnique({ where: { tier: row?.tier ?? 0 } });
    return {
      tier: row?.tier ?? 0,
      volume30d: formatAmountTrimmed(row ? toMinorUnits(row.volume30d) : 0n, VOLUME_SCALE),
      takerDiscountBps: tier?.takerDiscountBps ?? 0,
      makerDiscountBps: tier?.makerDiscountBps ?? 0,
      computedAt: row?.computedAt.toISOString() ?? null,
    };
  }

  async referrals(userId: string): Promise<ReferralSummaryDto> {
    const [code, referred, earned] = await Promise.all([
      this.prisma.referralCode.findUnique({ where: { userId } }),
      this.prisma.user.count({ where: { referredByUserId: userId } }),
      this.prisma.$queryRaw<{ code: string; scale: number; amount: string }[]>`
        SELECT a."code", a."scale", SUM(p."amount")::text AS "amount"
          FROM "fee_payouts" p JOIN "assets" a ON a."id" = p."asset_id"
         WHERE p."user_id" = ${userId}::uuid AND p."kind" = 'referral'
         GROUP BY a."code", a."scale" ORDER BY a."code"`,
    ]);
    return {
      code: code?.code ?? null,
      referred,
      earnings: earned.map((e) => ({
        asset: e.code,
        amount: formatAmountTrimmed(BigInt(e.amount), e.scale),
      })),
    };
  }

  /** Creates the account's referral code (wallet accounts only; one per account). */
  async createReferralCode(userId: string, ctx: RequestContext): Promise<{ code: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.walletAddress)
      throw AppError.forbidden(
        'Referral codes are for wallet accounts (payouts are claimable on-chain)',
      );
    const existing = await this.prisma.referralCode.findUnique({ where: { userId } });
    if (existing) return { code: existing.code };
    for (let i = 0; i < 5; i++) {
      const code = randomBytes(6)
        .toString('base64url')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      if (code.length < 6) continue;
      try {
        await this.prisma.referralCode.create({ data: { code: code.slice(0, 8), userId } });
        await this.audit.recordSafe({
          action: 'referral.code.created',
          outcome: 'SUCCESS',
          actorType: 'USER',
          actorUserId: userId,
          targetType: 'user',
          targetId: userId,
          context: ctx,
        });
        return { code: code.slice(0, 8) };
      } catch {
        // collision: try another
      }
    }
    throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE', 'Please try again');
  }

  /** Public leaderboard: sum of points over the last `days` days (accounts shown shortened). */
  async leaderboard(days: number, limit = 100): Promise<PointsEntryDto[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.$queryRaw<
      { user_id: string; wallet: string | null; points: string }[]
    >`
      SELECT p."user_id", COALESCE(u."wallet_address", parent."wallet_address") AS "wallet",
             SUM(p."points")::text AS "points"
        FROM "user_points" p JOIN "users" u ON u."id" = p."user_id"
        LEFT JOIN "users" parent ON parent."id" = u."parent_user_id"
       WHERE p."day" >= ${since}::date
       GROUP BY p."user_id", 2 HAVING SUM(p."points") > 0
       ORDER BY SUM(p."points") DESC, p."user_id" LIMIT ${limit}`;
    return rows.map((r, i) => ({
      rank: i + 1,
      account: shortAccount(r.wallet, r.user_id),
      points: r.points,
    }));
  }

  async myPoints(
    userId: string,
    days: number,
  ): Promise<{ points: string; excludedVolume: string }> {
    const since = new Date(Date.now() - days * 86_400_000);
    const agg = await this.prisma.userPoints.aggregate({
      where: { userId, day: { gte: since } },
      _sum: { points: true, excludedVolume: true },
    });
    return {
      points: (agg._sum.points ?? 0).toString(),
      excludedVolume: formatAmountTrimmed(
        agg._sum.excludedVolume ? toMinorUnits(agg._sum.excludedVolume) : 0n,
        VOLUME_SCALE,
      ),
    };
  }
}
