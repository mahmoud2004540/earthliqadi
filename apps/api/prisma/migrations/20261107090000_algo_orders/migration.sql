-- Algorithmic orders for large traders (ADR-0020): TWAP and iceberg.
-- The server slices a parent order into ordinary child orders; every child
-- goes through normal order entry (holds, risk checks, engine, settlement).
CREATE TABLE "algo_orders" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "market_id" UUID NOT NULL,
  "kind" VARCHAR(8) NOT NULL,
  "side" "OrderSide" NOT NULL,
  "total_lots" BIGINT NOT NULL,
  "slice_lots" BIGINT NOT NULL,
  "price_ticks" BIGINT NOT NULL,
  "interval_seconds" INTEGER,
  "reduce_only" BOOLEAN NOT NULL DEFAULT false,
  "status" VARCHAR(10) NOT NULL DEFAULT 'RUNNING',
  "slices_sent" INTEGER NOT NULL DEFAULT 0,
  "next_at" TIMESTAMPTZ(3) NOT NULL,
  "last_error" VARCHAR(256),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "algo_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "algo_orders_chk" CHECK (
    "kind" IN ('TWAP', 'ICEBERG') AND "status" IN ('RUNNING', 'DONE', 'CANCELLED', 'FAILED')
    AND "total_lots" > 0 AND "slice_lots" > 0 AND "slice_lots" <= "total_lots" AND "price_ticks" > 0
    AND (("kind" = 'TWAP') = ("interval_seconds" IS NOT NULL))
    AND ("interval_seconds" IS NULL OR "interval_seconds" BETWEEN 5 AND 86400))
);
CREATE INDEX "algo_orders_running_idx" ON "algo_orders"("next_at") WHERE "status" = 'RUNNING';
CREATE INDEX "algo_orders_user_idx" ON "algo_orders"("user_id", "created_at");
ALTER TABLE "algo_orders" ADD CONSTRAINT "algo_orders_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "algo_orders" ADD CONSTRAINT "algo_orders_market_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "orders" ADD COLUMN "algo_order_id" UUID;
CREATE INDEX "orders_algo_order_id_idx" ON "orders"("algo_order_id") WHERE "algo_order_id" IS NOT NULL;
