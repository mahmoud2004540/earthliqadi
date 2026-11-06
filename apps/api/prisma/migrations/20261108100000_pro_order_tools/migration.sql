-- Pro order tools (ADR-0025): hidden orders, trailing stop, chase and grid algo orders.

-- Hidden orders rest and match normally but are left out of the public book.
ALTER TABLE "orders" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD CONSTRAINT "orders_hidden_limit_chk"
  CHECK (NOT "hidden" OR ("type" = 'LIMIT' AND "time_in_force" IN ('GTC', 'POST_ONLY')));
-- Grid children: the grid level (0..gridCount) the order sits on.
ALTER TABLE "orders" ADD COLUMN "grid_level" SMALLINT;
CREATE INDEX "orders_algo_order_idx" ON "orders" ("algo_order_id");

-- Trailing stops have no limit price of their own.
ALTER TABLE "algo_orders" ALTER COLUMN "price_ticks" DROP NOT NULL;
ALTER TABLE "algo_orders"
  ADD COLUMN "callback_bps" INTEGER,
  ADD COLUMN "slippage_bps" INTEGER,
  ADD COLUMN "activation_ticks" BIGINT,
  ADD COLUMN "extreme_ticks" BIGINT,
  ADD COLUMN "activated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "grid_lower_ticks" BIGINT,
  ADD COLUMN "grid_upper_ticks" BIGINT,
  ADD COLUMN "grid_count" INTEGER,
  ADD COLUMN "grid_direction" VARCHAR(8),
  ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "copied_from_id" UUID REFERENCES "algo_orders" ("id");

-- Replaces the TWAP/iceberg-only check of ADR-0020 with the same rules for all kinds.
ALTER TABLE "algo_orders" DROP CONSTRAINT "algo_orders_chk";
ALTER TABLE "algo_orders" ADD CONSTRAINT "algo_orders_chk" CHECK (
  "kind" IN ('TWAP', 'ICEBERG', 'TRAILING', 'CHASE', 'GRID')
  AND "status" IN ('RUNNING', 'DONE', 'CANCELLED', 'FAILED')
  AND "total_lots" > 0 AND "slice_lots" > 0 AND "slice_lots" <= "total_lots"
  AND ("price_ticks" IS NULL OR "price_ticks" > 0)
  AND (("kind" = 'TWAP') = ("interval_seconds" IS NOT NULL))
  AND ("interval_seconds" IS NULL OR "interval_seconds" BETWEEN 5 AND 86400));
ALTER TABLE "algo_orders" ADD CONSTRAINT "algo_orders_trailing_chk"
  CHECK ("kind" <> 'TRAILING' OR ("callback_bps" BETWEEN 10 AND 2000 AND "slippage_bps" BETWEEN 10 AND 1000));
ALTER TABLE "algo_orders" ADD CONSTRAINT "algo_orders_price_chk"
  CHECK (("kind" IN ('TRAILING', 'GRID')) = ("price_ticks" IS NULL));
ALTER TABLE "algo_orders" ADD CONSTRAINT "algo_orders_grid_chk"
  CHECK ("kind" <> 'GRID' OR (
    "grid_lower_ticks" > 0 AND "grid_upper_ticks" > "grid_lower_ticks"
    AND "grid_count" BETWEEN 2 AND 100
    AND "grid_direction" IN ('LONG', 'SHORT', 'NEUTRAL')));
ALTER TABLE "algo_orders" ADD CONSTRAINT "algo_orders_public_chk"
  CHECK (NOT "is_public" OR "kind" = 'GRID');
CREATE INDEX "algo_orders_public_idx" ON "algo_orders" ("created_at") WHERE "is_public";
