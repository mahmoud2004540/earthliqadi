-- Fee tiers, maker rebates, referral fee share and activity points (ADR-0018).
-- Every payout comes out of the taker fee of the same trade: nothing is minted.

-- Public fee schedule: discounts on each market's base fees by 30-day volume
-- (in the reference quote asset). A negative effective maker fee is a rebate.
CREATE TABLE "fee_tiers" (
  "tier" INTEGER NOT NULL,
  "min_volume" DECIMAL(38,0) NOT NULL,
  "taker_discount_bps" INTEGER NOT NULL,
  "maker_discount_bps" INTEGER NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fee_tiers_pkey" PRIMARY KEY ("tier"),
  CONSTRAINT "fee_tiers_values_chk" CHECK (
    "tier" BETWEEN 0 AND 20 AND "min_volume" >= 0
    AND "taker_discount_bps" BETWEEN 0 AND 1000 AND "maker_discount_bps" BETWEEN 0 AND 1000),
  CONSTRAINT "fee_tiers_zero_chk" CHECK ("tier" <> 0 OR ("min_volume" = 0 AND "taker_discount_bps" = 0 AND "maker_discount_bps" = 0))
);
-- Default schedule (volume in reference-asset minor units, 6 decimals: 1e6 = 1 unit).
INSERT INTO "fee_tiers" ("tier", "min_volume", "taker_discount_bps", "maker_discount_bps") VALUES
  (0, 0, 0, 0),
  (1, 1000000000000, 1, 1),        --     1 000 000 / 30 days
  (2, 10000000000000, 2, 2),       --    10 000 000
  (3, 50000000000000, 3, 3),       --    50 000 000
  (4, 200000000000000, 4, 4);      --   200 000 000

-- Each account's current tier, recomputed by the growth job.
CREATE TABLE "user_fee_tiers" (
  "user_id" UUID NOT NULL,
  "tier" INTEGER NOT NULL,
  "volume_30d" DECIMAL(38,0) NOT NULL,
  "computed_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "user_fee_tiers_pkey" PRIMARY KEY ("user_id")
);
ALTER TABLE "user_fee_tiers" ADD CONSTRAINT "user_fee_tiers_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Referrals: one code per account; the referrer is set once, at account creation.
CREATE TABLE "referral_codes" (
  "code" VARCHAR(16) NOT NULL,
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("code"),
  CONSTRAINT "referral_codes_format_chk" CHECK ("code" ~ '^[a-z0-9]{6,16}$')
);
CREATE UNIQUE INDEX "referral_codes_user_id_key" ON "referral_codes"("user_id");
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "users" ADD COLUMN "referred_by_user_id" UUID;
ALTER TABLE "users" ADD CONSTRAINT "users_referred_by_user_id_fkey"
  FOREIGN KEY ("referred_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_referral_self_chk" CHECK ("referred_by_user_id" IS DISTINCT FROM "id");
CREATE INDEX "users_referred_by_user_id_idx" ON "users"("referred_by_user_id");
CREATE OR REPLACE FUNCTION users_referral_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."referred_by_user_id" IS DISTINCT FROM OLD."referred_by_user_id" THEN
    RAISE EXCEPTION 'referrer is set once at account creation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER users_referral_immutable BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_referral_immutable();

-- Every rebate and referral payout, linked to the trade that funded it.
CREATE TABLE "fee_payouts" (
  "id" BIGSERIAL NOT NULL,
  "trade_key" VARCHAR(128) NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "user_id" UUID NOT NULL,
  "source_user_id" UUID NOT NULL,
  "asset_id" UUID NOT NULL,
  "amount" DECIMAL(38,0) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fee_payouts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fee_payouts_kind_chk" CHECK ("kind" IN ('maker_rebate', 'referral')),
  CONSTRAINT "fee_payouts_amount_chk" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "fee_payouts_trade_kind_key" ON "fee_payouts"("trade_key", "kind");
CREATE INDEX "fee_payouts_user_id_idx" ON "fee_payouts"("user_id", "created_at");

-- Activity points per account and UTC day. Not a token, not a promise of one.
CREATE TABLE "user_points" (
  "user_id" UUID NOT NULL,
  "day" DATE NOT NULL,
  "points" DECIMAL(38,0) NOT NULL,
  "excluded_volume" DECIMAL(38,0) NOT NULL DEFAULT 0,
  "computed_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "user_points_pkey" PRIMARY KEY ("user_id", "day")
);
ALTER TABLE "user_points" ADD CONSTRAINT "user_points_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
