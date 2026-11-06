import type { Prisma } from '@prisma/client';
import type { AppConfig } from '../config/app-config';
import { NO_DISCOUNT, type FeeProfile } from './fee-math';

/**
 * Loads fee discounts and eligible referrers for the users of one settlement
 * batch (ADR-0018). A referral pays while the referred account is younger than
 * REFERRAL_DURATION_DAYS and the referrer is an active wallet account.
 */
export async function loadFeeProfiles(
  tx: Prisma.TransactionClient,
  userIds: string[],
  config: Pick<AppConfig, 'REFERRAL_DURATION_DAYS' | 'REFERRAL_FEE_SHARE_BPS'>,
  now = new Date(),
): Promise<Map<string, FeeProfile>> {
  const out = new Map<string, FeeProfile>();
  if (userIds.length === 0) return out;
  const cutoff = new Date(now.getTime() - config.REFERRAL_DURATION_DAYS * 86_400_000);
  const rows = await tx.$queryRaw<
    {
      id: string;
      taker_discount_bps: number | null;
      maker_discount_bps: number | null;
      referrer_id: string | null;
    }[]
  >`
    SELECT u."id", ft."taker_discount_bps", ft."maker_discount_bps",
           CASE WHEN r."id" IS NOT NULL AND r."status" = 'ACTIVE' AND r."wallet_address" IS NOT NULL
                     AND u."created_at" > ${cutoff}
                THEN r."id" END AS "referrer_id"
      FROM "users" u
      LEFT JOIN "user_fee_tiers" uft ON uft."user_id" = u."id"
      LEFT JOIN "fee_tiers" ft ON ft."tier" = uft."tier"
      LEFT JOIN "users" r ON r."id" = u."referred_by_user_id"
     WHERE u."id" = ANY(${userIds}::uuid[])`;
  for (const r of rows) {
    out.set(r.id, {
      takerDiscountBps: r.taker_discount_bps ?? 0,
      makerDiscountBps: r.maker_discount_bps ?? 0,
      referrerId: config.REFERRAL_FEE_SHARE_BPS > 0 ? r.referrer_id : null,
    });
  }
  for (const id of userIds) if (!out.has(id)) out.set(id, NO_DISCOUNT);
  return out;
}
