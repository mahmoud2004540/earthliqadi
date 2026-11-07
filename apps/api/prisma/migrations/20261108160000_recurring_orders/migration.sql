-- Recurring purchases / sales (ADR-0029): a fixed amount every interval.
ALTER TABLE "algo_orders" ALTER COLUMN "kind" TYPE VARCHAR(12);
ALTER TABLE "algo_orders"
  ADD COLUMN "run_amount" DECIMAL(38, 0),
  ADD COLUMN "runs_total" INTEGER;

ALTER TABLE "algo_orders" DROP CONSTRAINT "algo_orders_chk";
ALTER TABLE "algo_orders" ADD CONSTRAINT "algo_orders_chk" CHECK (
  "kind" IN ('TWAP', 'ICEBERG', 'TRAILING', 'CHASE', 'GRID', 'RECURRING')
  AND "status" IN ('RUNNING', 'DONE', 'CANCELLED', 'FAILED')
  AND "total_lots" > 0 AND "slice_lots" > 0 AND "slice_lots" <= "total_lots"
  AND ("price_ticks" IS NULL OR "price_ticks" > 0)
  AND (("kind" IN ('TWAP', 'RECURRING')) = ("interval_seconds" IS NOT NULL))
  AND ("interval_seconds" IS NULL OR "interval_seconds" BETWEEN 5 AND 2592000)
  AND ("kind" <> 'TWAP' OR "interval_seconds" <= 86400));

ALTER TABLE "algo_orders" DROP CONSTRAINT "algo_orders_price_chk";
ALTER TABLE "algo_orders" ADD CONSTRAINT "algo_orders_price_chk"
  CHECK ("kind" IN ('TRAILING', 'GRID', 'RECURRING') OR "price_ticks" IS NOT NULL);
ALTER TABLE "algo_orders" ADD CONSTRAINT "algo_orders_recurring_chk"
  CHECK (("kind" = 'RECURRING') = ("run_amount" IS NOT NULL AND "runs_total" IS NOT NULL)
     AND ("run_amount" IS NULL OR "run_amount" > 0)
     AND ("runs_total" IS NULL OR "runs_total" BETWEEN 1 AND 1000)
     AND ("kind" <> 'RECURRING' OR ("slippage_bps" BETWEEN 10 AND 500 AND "interval_seconds" >= 3600)));
