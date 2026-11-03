-- Paper trading namespace (ADR-0010).
ALTER TYPE "LedgerAccountType" ADD VALUE 'PAPER_FAUCET';
ALTER TYPE "JournalEntryType" ADD VALUE 'PAPER_FAUCET_GRANT';

ALTER TABLE "assets" ADD COLUMN "is_paper" BOOLEAN NOT NULL DEFAULT false,
                     ADD COLUMN "faucet_amount" DECIMAL(38,0);
ALTER TABLE "assets" ADD CONSTRAINT "assets_faucet_chk"
  CHECK ("faucet_amount" IS NULL OR ("is_paper" AND "faucet_amount" > 0));
ALTER TABLE "markets" ADD COLUMN "is_paper" BOOLEAN NOT NULL DEFAULT false;

-- Asset identity (code, scale, paper flag) is immutable.
CREATE OR REPLACE FUNCTION assets_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW."scale" IS DISTINCT FROM OLD."scale" OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."is_paper" IS DISTINCT FROM OLD."is_paper" THEN
    RAISE EXCEPTION 'asset code, scale and paper flag are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A market's paper flag must match BOTH assets (no market can mix namespaces).
CREATE OR REPLACE FUNCTION markets_check_namespace() RETURNS trigger AS $$
DECLARE base_paper BOOLEAN; quote_paper BOOLEAN;
BEGIN
  SELECT "is_paper" INTO base_paper FROM "assets" WHERE "id" = NEW."base_asset_id";
  SELECT "is_paper" INTO quote_paper FROM "assets" WHERE "id" = NEW."quote_asset_id";
  IF base_paper IS DISTINCT FROM quote_paper OR NEW."is_paper" IS DISTINCT FROM base_paper THEN
    RAISE EXCEPTION 'market assets and market must all be paper or all be real' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER markets_check_namespace BEFORE INSERT ON "markets"
  FOR EACH ROW EXECUTE FUNCTION markets_check_namespace();

CREATE OR REPLACE FUNCTION markets_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW."symbol" IS DISTINCT FROM OLD."symbol" OR NEW."base_asset_id" IS DISTINCT FROM OLD."base_asset_id"
     OR NEW."quote_asset_id" IS DISTINCT FROM OLD."quote_asset_id" OR NEW."tick_size" IS DISTINCT FROM OLD."tick_size"
     OR NEW."lot_size" IS DISTINCT FROM OLD."lot_size" OR NEW."is_paper" IS DISTINCT FROM OLD."is_paper" THEN
    RAISE EXCEPTION 'market symbol, assets, tick size, lot size and paper flag are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."next_command_seq" < OLD."next_command_seq" THEN
    RAISE EXCEPTION 'market command sequence cannot go backwards' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Account types per namespace: faucets only for paper assets; development simulated custody only for real assets.
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_accounts_check_namespace BEFORE INSERT ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION ledger_accounts_check_namespace();

-- No journal entry may contain postings on both paper and real assets (checked at COMMIT).
CREATE OR REPLACE FUNCTION ledger_check_entry_namespace() RETURNS trigger AS $$
DECLARE namespaces INT;
BEGIN
  SELECT count(DISTINCT a."is_paper") INTO namespaces
    FROM "postings" p JOIN "assets" a ON a."id" = p."asset_id"
   WHERE p."entry_id" = NEW."entry_id";
  IF namespaces > 1 THEN
    RAISE EXCEPTION 'journal entry % mixes paper and real assets', NEW."entry_id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER postings_single_namespace AFTER INSERT ON "postings"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_entry_namespace();
