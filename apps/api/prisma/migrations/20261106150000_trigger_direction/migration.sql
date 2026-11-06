-- Take-profit / stop-loss (ADR-0017 part 2): the direction in which the last
-- trade price must cross a stop order's stop price. NULL keeps the classic
-- stop (buy at or above, sell at or below).
ALTER TABLE "orders" ADD COLUMN "trigger_direction" VARCHAR(5);
ALTER TABLE "orders" ADD CONSTRAINT "orders_trigger_direction_chk" CHECK (
  "trigger_direction" IS NULL OR
  ("trigger_direction" IN ('above', 'below') AND "type" IN ('STOP_LIMIT', 'STOP_MARKET')));

-- One-cancels-the-other group for a position's take-profit / stop-loss pair.
ALTER TABLE "orders" ADD COLUMN "oco_group_id" UUID;
ALTER TABLE "orders" ADD CONSTRAINT "orders_oco_chk" CHECK (
  "oco_group_id" IS NULL OR ("reduce_only" AND "type" IN ('STOP_LIMIT', 'STOP_MARKET')));
CREATE INDEX "orders_oco_group_id_idx" ON "orders"("oco_group_id") WHERE "oco_group_id" IS NOT NULL;
