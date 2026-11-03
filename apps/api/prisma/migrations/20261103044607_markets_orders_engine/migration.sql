-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('ACTIVE', 'HALTED');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('LIMIT', 'MARKET', 'STOP_LIMIT', 'STOP_MARKET');

-- CreateEnum
CREATE TYPE "TimeInForce" AS ENUM ('GTC', 'IOC', 'FOK', 'POST_ONLY');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_NEW', 'PENDING_TRIGGER', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED');

-- AlterEnum
ALTER TYPE "JournalEntryType" ADD VALUE 'TRADE';

-- CreateTable
CREATE TABLE "markets" (
    "id" UUID NOT NULL,
    "symbol" VARCHAR(40) NOT NULL,
    "base_asset_id" UUID NOT NULL,
    "quote_asset_id" UUID NOT NULL,
    "tick_size" DECIMAL(38,0) NOT NULL,
    "lot_size" DECIMAL(38,0) NOT NULL,
    "min_quantity_lots" BIGINT NOT NULL DEFAULT 1,
    "maker_fee_bps" INTEGER NOT NULL,
    "taker_fee_bps" INTEGER NOT NULL,
    "status" "MarketStatus" NOT NULL DEFAULT 'ACTIVE',
    "next_command_seq" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "market_id" UUID NOT NULL,
    "client_order_id" VARCHAR(64) NOT NULL,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL,
    "time_in_force" "TimeInForce" NOT NULL,
    "price_ticks" BIGINT,
    "stop_price_ticks" BIGINT,
    "quantity_lots" BIGINT NOT NULL,
    "filled_lots" BIGINT NOT NULL DEFAULT 0,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_NEW',
    "hold_asset_id" UUID NOT NULL,
    "hold_amount" DECIMAL(38,0) NOT NULL,
    "locked_remaining" DECIMAL(38,0) NOT NULL,
    "reject_reason" VARCHAR(48),
    "cancel_reason" VARCHAR(48),
    "cancel_requested_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" UUID NOT NULL,
    "market_id" UUID NOT NULL,
    "event_seq" BIGINT NOT NULL,
    "maker_order_id" UUID NOT NULL,
    "taker_order_id" UUID NOT NULL,
    "buyer_user_id" UUID NOT NULL,
    "seller_user_id" UUID NOT NULL,
    "taker_side" "OrderSide" NOT NULL,
    "price_ticks" BIGINT NOT NULL,
    "quantity_lots" BIGINT NOT NULL,
    "base_amount" DECIMAL(38,0) NOT NULL,
    "quote_amount" DECIMAL(38,0) NOT NULL,
    "buyer_fee" DECIMAL(38,0) NOT NULL,
    "seller_fee" DECIMAL(38,0) NOT NULL,
    "journal_entry_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_commands" (
    "market_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "engine_commands_pkey" PRIMARY KEY ("market_id","seq")
);

-- CreateTable
CREATE TABLE "engine_events" (
    "market_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "command_seq" BIGINT NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "engine_events_pkey" PRIMARY KEY ("market_id","seq")
);

-- CreateTable
CREATE TABLE "engine_market_state" (
    "market_id" UUID NOT NULL,
    "last_command_seq" BIGINT NOT NULL,
    "last_event_seq" BIGINT NOT NULL,
    "state_hash" CHAR(64) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "engine_market_state_pkey" PRIMARY KEY ("market_id")
);

-- CreateTable
CREATE TABLE "settlement_state" (
    "market_id" UUID NOT NULL,
    "last_event_seq" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settlement_state_pkey" PRIMARY KEY ("market_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "markets_symbol_key" ON "markets"("symbol");

-- CreateIndex
CREATE INDEX "orders_user_id_created_at_idx" ON "orders"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_market_id_status_idx" ON "orders"("market_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_user_id_client_order_id_key" ON "orders"("user_id", "client_order_id");

-- CreateIndex
CREATE INDEX "trades_buyer_user_id_created_at_idx" ON "trades"("buyer_user_id", "created_at");

-- CreateIndex
CREATE INDEX "trades_seller_user_id_created_at_idx" ON "trades"("seller_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "trades_market_id_event_seq_key" ON "trades"("market_id", "event_seq");

-- AddForeignKey
ALTER TABLE "markets" ADD CONSTRAINT "markets_base_asset_id_fkey" FOREIGN KEY ("base_asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markets" ADD CONSTRAINT "markets_quote_asset_id_fkey" FOREIGN KEY ("quote_asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_hold_asset_id_fkey" FOREIGN KEY ("hold_asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Invariants for markets, orders, trades and the engine log (ADR-0007)
-- ===========================================================================

ALTER TABLE "markets" ADD CONSTRAINT "markets_symbol_format_chk" CHECK ("symbol" ~ '^[A-Z0-9]{2,16}-[A-Z0-9]{2,16}$');
ALTER TABLE "markets" ADD CONSTRAINT "markets_distinct_assets_chk" CHECK ("base_asset_id" <> "quote_asset_id");
ALTER TABLE "markets" ADD CONSTRAINT "markets_sizes_chk" CHECK ("tick_size" > 0 AND "lot_size" > 0 AND "min_quantity_lots" >= 1);
ALTER TABLE "markets" ADD CONSTRAINT "markets_fees_chk" CHECK ("maker_fee_bps" BETWEEN 0 AND 1000 AND "taker_fee_bps" BETWEEN 0 AND 1000);
ALTER TABLE "markets" ADD CONSTRAINT "markets_command_seq_chk" CHECK ("next_command_seq" >= 0);

-- Market unit definitions are immutable once created (they give meaning to every stored price/quantity).
CREATE OR REPLACE FUNCTION markets_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW."symbol" IS DISTINCT FROM OLD."symbol" OR NEW."base_asset_id" IS DISTINCT FROM OLD."base_asset_id"
     OR NEW."quote_asset_id" IS DISTINCT FROM OLD."quote_asset_id" OR NEW."tick_size" IS DISTINCT FROM OLD."tick_size"
     OR NEW."lot_size" IS DISTINCT FROM OLD."lot_size" THEN
    RAISE EXCEPTION 'market symbol, assets, tick size and lot size are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."next_command_seq" < OLD."next_command_seq" THEN
    RAISE EXCEPTION 'market command sequence cannot go backwards' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER markets_guard_update BEFORE UPDATE ON "markets" FOR EACH ROW EXECUTE FUNCTION markets_guard_update();
CREATE TRIGGER markets_no_delete BEFORE DELETE ON "markets" FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();

ALTER TABLE "orders" ADD CONSTRAINT "orders_quantity_chk" CHECK ("quantity_lots" BETWEEN 1 AND 1000000000000);
ALTER TABLE "orders" ADD CONSTRAINT "orders_filled_chk" CHECK ("filled_lots" BETWEEN 0 AND "quantity_lots");
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_chk" CHECK (
  ("price_ticks" IS NULL OR "price_ticks" BETWEEN 1 AND 1000000000000)
  AND ("stop_price_ticks" IS NULL OR "stop_price_ticks" BETWEEN 1 AND 1000000000000));
ALTER TABLE "orders" ADD CONSTRAINT "orders_locked_chk" CHECK ("locked_remaining" >= 0 AND "locked_remaining" <= "hold_amount");
ALTER TABLE "orders" ADD CONSTRAINT "orders_terminal_locked_chk" CHECK (
  "status" NOT IN ('FILLED', 'CANCELLED', 'REJECTED') OR "locked_remaining" = 0);
CREATE TRIGGER orders_no_delete BEFORE DELETE ON "orders" FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();

ALTER TABLE "trades" ADD CONSTRAINT "trades_positive_chk" CHECK (
  "price_ticks" > 0 AND "quantity_lots" > 0 AND "base_amount" > 0 AND "quote_amount" > 0
  AND "buyer_fee" >= 0 AND "seller_fee" >= 0 AND "buyer_user_id" <> "seller_user_id");
CREATE TRIGGER trades_immutable BEFORE UPDATE OR DELETE ON "trades" FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();
CREATE TRIGGER trades_no_truncate BEFORE TRUNCATE ON "trades" FOR EACH STATEMENT EXECUTE FUNCTION ledger_block_mutation();

ALTER TABLE "engine_commands" ADD CONSTRAINT "engine_commands_seq_chk" CHECK ("seq" >= 1);
ALTER TABLE "engine_commands" ADD CONSTRAINT "engine_commands_kind_chk" CHECK ("kind" IN ('place', 'cancel', 'reduce'));
CREATE TRIGGER engine_commands_immutable BEFORE UPDATE OR DELETE ON "engine_commands" FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();
CREATE TRIGGER engine_commands_no_truncate BEFORE TRUNCATE ON "engine_commands" FOR EACH STATEMENT EXECUTE FUNCTION ledger_block_mutation();

-- A command's sequence must be exactly the market's counter value (gap-free, commit-ordered).
CREATE OR REPLACE FUNCTION engine_commands_check_seq() RETURNS trigger AS $$
DECLARE current_seq BIGINT;
BEGIN
  SELECT "next_command_seq" INTO current_seq FROM "markets" WHERE "id" = NEW."market_id";
  IF current_seq IS NULL OR NEW."seq" <> current_seq THEN
    RAISE EXCEPTION 'engine command seq % does not match market counter %', NEW."seq", current_seq
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER engine_commands_check_seq BEFORE INSERT ON "engine_commands" FOR EACH ROW EXECUTE FUNCTION engine_commands_check_seq();

ALTER TABLE "engine_events" ADD CONSTRAINT "engine_events_seq_chk" CHECK ("seq" >= 1 AND "command_seq" >= 1);
CREATE TRIGGER engine_events_immutable BEFORE UPDATE OR DELETE ON "engine_events" FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();
CREATE TRIGGER engine_events_no_truncate BEFORE TRUNCATE ON "engine_events" FOR EACH STATEMENT EXECUTE FUNCTION ledger_block_mutation();

-- Offsets only move forward.
CREATE OR REPLACE FUNCTION offsets_forward_only() RETURNS trigger AS $$
BEGIN
  IF NEW."last_event_seq" < OLD."last_event_seq" THEN
    RAISE EXCEPTION 'offsets cannot move backwards' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER engine_market_state_forward BEFORE UPDATE ON "engine_market_state" FOR EACH ROW EXECUTE FUNCTION offsets_forward_only();
CREATE TRIGGER settlement_state_forward BEFORE UPDATE ON "settlement_state" FOR EACH ROW EXECUTE FUNCTION offsets_forward_only();
