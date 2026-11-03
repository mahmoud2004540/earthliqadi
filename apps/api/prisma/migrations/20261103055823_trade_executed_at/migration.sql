-- Fill time for market data (ADR-0009). Backfilled from the engine event that produced each trade.
-- trades is immutable (ADR-0007); the backfill temporarily lifts the guard inside this migration only.
ALTER TABLE "trades" ADD COLUMN "executed_at" TIMESTAMPTZ(3);

ALTER TABLE "trades" DISABLE TRIGGER "trades_immutable";
UPDATE "trades" t SET "executed_at" = e."created_at"
  FROM "engine_events" e
 WHERE e."market_id" = t."market_id" AND e."seq" = t."event_seq";
UPDATE "trades" SET "executed_at" = "created_at" WHERE "executed_at" IS NULL;
ALTER TABLE "trades" ENABLE TRIGGER "trades_immutable";

ALTER TABLE "trades" ALTER COLUMN "executed_at" SET NOT NULL;
CREATE INDEX "trades_market_id_executed_at_idx" ON "trades"("market_id", "executed_at");
