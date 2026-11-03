-- Perpetual futures, paper only (ADR-0011).
ALTER TYPE "LedgerAccountType" ADD VALUE 'USER_MARGIN';
ALTER TYPE "LedgerAccountType" ADD VALUE 'PERP_CLEARING';
ALTER TYPE "LedgerAccountType" ADD VALUE 'INSURANCE_FUND';
ALTER TYPE "LedgerAccountType" ADD VALUE 'PERP_FUNDING_POOL';
ALTER TYPE "JournalEntryType" ADD VALUE 'MARGIN_TRANSFER';
ALTER TYPE "JournalEntryType" ADD VALUE 'FUNDING';
ALTER TYPE "JournalEntryType" ADD VALUE 'INSURANCE_FUND_SEED';

CREATE TYPE "MarketKind" AS ENUM ('SPOT', 'PERPETUAL');
CREATE TYPE "PositionStatus" AS ENUM ('NORMAL', 'LIQUIDATING');

ALTER TABLE "markets" ADD COLUMN "kind" "MarketKind" NOT NULL DEFAULT 'SPOT',
                      ADD COLUMN "perp_config" JSONB;
-- Perpetuals exist only as paper markets until separately authorised (spec §15).
ALTER TABLE "markets" ADD CONSTRAINT "markets_perp_paper_only_chk" CHECK ("kind" = 'SPOT' OR "is_paper");
-- Perpetual symbols carry a -PERP suffix; spot symbols never do.
ALTER TABLE "markets" DROP CONSTRAINT "markets_symbol_format_chk";
ALTER TABLE "markets" ADD CONSTRAINT "markets_symbol_format_chk" CHECK (
  ("kind" = 'SPOT' AND "symbol" ~ '^[A-Z0-9]{2,16}-[A-Z0-9]{2,16}$') OR
  ("kind" = 'PERPETUAL' AND "symbol" ~ '^[A-Z0-9]{2,16}-[A-Z0-9]{2,16}-PERP$'));
ALTER TABLE "markets" ADD CONSTRAINT "markets_perp_config_chk"
  CHECK (("kind" = 'PERPETUAL') = ("perp_config" IS NOT NULL));

ALTER TABLE "orders" ADD COLUMN "reduce_only" BOOLEAN NOT NULL DEFAULT false,
                     ADD COLUMN "is_liquidation" BOOLEAN NOT NULL DEFAULT false,
                     ADD COLUMN "leverage" INTEGER;
ALTER TABLE "orders" ADD CONSTRAINT "orders_leverage_chk" CHECK ("leverage" IS NULL OR "leverage" BETWEEN 1 AND 125);

CREATE TABLE "positions" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "market_id" UUID NOT NULL,
  "size_lots" BIGINT NOT NULL DEFAULT 0,
  "entry_notional" DECIMAL(38,0) NOT NULL DEFAULT 0,
  "margin" DECIMAL(38,0) NOT NULL DEFAULT 0,
  "leverage" INTEGER NOT NULL,
  "status" "PositionStatus" NOT NULL DEFAULT 'NORMAL',
  "realized_pnl" DECIMAL(38,0) NOT NULL DEFAULT 0,
  "funding_pnl" DECIMAL(38,0) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "positions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "positions_margin_chk" CHECK ("margin" >= 0),
  CONSTRAINT "positions_leverage_chk" CHECK ("leverage" BETWEEN 1 AND 125),
  -- A flat position carries no entry notional and no margin.
  CONSTRAINT "positions_flat_chk" CHECK ("size_lots" <> 0 OR ("entry_notional" = 0 AND "margin" = 0)),
  -- Entry notional has the sign of the position.
  CONSTRAINT "positions_entry_sign_chk" CHECK (sign("entry_notional") = sign("size_lots"))
);
CREATE UNIQUE INDEX "positions_user_id_market_id_key" ON "positions"("user_id", "market_id");
CREATE INDEX "positions_market_id_size_lots_idx" ON "positions"("market_id", "size_lots");
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "positions" ADD CONSTRAINT "positions_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "perp_price_samples" (
  "market_id" UUID NOT NULL,
  "sampled_at" TIMESTAMPTZ(3) NOT NULL,
  "index_price" DECIMAL(38,0) NOT NULL,
  "mark_price" DECIMAL(38,0) NOT NULL,
  "mid_price" DECIMAL(38,0),
  "premium_rate" BIGINT,
  "sources_used" INTEGER NOT NULL,
  CONSTRAINT "perp_price_samples_pkey" PRIMARY KEY ("market_id", "sampled_at")
);
ALTER TABLE "perp_price_samples" ADD CONSTRAINT "perp_price_samples_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Mutable risk-engine state per market (basis EMA, simulated source prices).
CREATE TABLE "perp_market_state" (
  "market_id" UUID NOT NULL,
  "basis_ema" DECIMAL(38,0) NOT NULL DEFAULT 0,
  "simulated_prices" JSONB NOT NULL DEFAULT '{}',
  "last_funding_at" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "perp_market_state_pkey" PRIMARY KEY ("market_id")
);
ALTER TABLE "perp_market_state" ADD CONSTRAINT "perp_market_state_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "perp_funding_rounds" (
  "id" UUID NOT NULL,
  "market_id" UUID NOT NULL,
  "funding_time" TIMESTAMPTZ(3) NOT NULL,
  "rate" BIGINT NOT NULL,
  "mark_price" DECIMAL(38,0) NOT NULL,
  "collected" DECIMAL(38,0) NOT NULL,
  "distributed" DECIMAL(38,0) NOT NULL,
  "positions" INTEGER NOT NULL,
  "journal_entry_id" BIGINT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "perp_funding_rounds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "perp_funding_rounds_zero_sum_chk" CHECK ("distributed" <= "collected" AND "distributed" >= 0)
);
CREATE UNIQUE INDEX "perp_funding_rounds_market_id_funding_time_key" ON "perp_funding_rounds"("market_id", "funding_time");
ALTER TABLE "perp_funding_rounds" ADD CONSTRAINT "perp_funding_rounds_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Funding rounds and price samples are history: append-only.
CREATE OR REPLACE FUNCTION perp_history_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER perp_funding_rounds_immutable BEFORE UPDATE OR DELETE ON "perp_funding_rounds"
  FOR EACH ROW EXECUTE FUNCTION perp_history_immutable();
CREATE TRIGGER perp_price_samples_immutable BEFORE UPDATE OR DELETE ON "perp_price_samples"
  FOR EACH ROW EXECUTE FUNCTION perp_history_immutable();

-- Market kind is immutable as well.
CREATE OR REPLACE FUNCTION markets_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW."symbol" IS DISTINCT FROM OLD."symbol" OR NEW."base_asset_id" IS DISTINCT FROM OLD."base_asset_id"
     OR NEW."quote_asset_id" IS DISTINCT FROM OLD."quote_asset_id" OR NEW."tick_size" IS DISTINCT FROM OLD."tick_size"
     OR NEW."lot_size" IS DISTINCT FROM OLD."lot_size" OR NEW."is_paper" IS DISTINCT FROM OLD."is_paper"
     OR NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION 'market symbol, assets, tick size, lot size, paper flag and kind are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."next_command_seq" < OLD."next_command_seq" THEN
    RAISE EXCEPTION 'market command sequence cannot go backwards' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Derivatives account types exist only for paper assets (no real-money derivatives).
CREATE OR REPLACE FUNCTION ledger_accounts_check_namespace() RETURNS trigger AS $$
DECLARE paper BOOLEAN;
BEGIN
  SELECT "is_paper" INTO paper FROM "assets" WHERE "id" = NEW."asset_id";
  IF NEW."type"::text = 'PAPER_FAUCET' AND NOT paper THEN
    RAISE EXCEPTION 'PAPER_FAUCET accounts are only allowed for paper assets' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."type"::text = 'SIMULATED_CUSTODY' AND paper THEN
    RAISE EXCEPTION 'SIMULATED_CUSTODY accounts are only allowed for real assets' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."type"::text IN ('USER_MARGIN', 'PERP_CLEARING', 'INSURANCE_FUND', 'PERP_FUNDING_POOL') AND NOT paper THEN
    RAISE EXCEPTION '% accounts are only allowed for paper assets (derivatives are paper-only)', NEW."type" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- USER_MARGIN is user-owned like USER_AVAILABLE/USER_LOCKED (text comparison: new enum values
-- cannot be referenced as enum literals in the transaction that adds them).
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_owner_chk";
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_chk" CHECK (
  ("type"::text IN ('USER_AVAILABLE', 'USER_LOCKED', 'USER_MARGIN') AND "owner_user_id" IS NOT NULL AND "owner_key" = "owner_user_id"::text)
  OR ("type"::text NOT IN ('USER_AVAILABLE', 'USER_LOCKED', 'USER_MARGIN') AND "owner_user_id" IS NULL AND "owner_key" = 'system'));
