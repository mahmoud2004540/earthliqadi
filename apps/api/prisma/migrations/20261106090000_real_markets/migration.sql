-- Real markets only (product brief rev 2, ADR-0016).
-- Paper trading is retired: existing paper rows stay as immutable history, but
-- no new paper asset, market or faucet grant can be created, and paper markets
-- are halted. Perpetuals are allowed on real assets.

CREATE OR REPLACE FUNCTION no_new_paper_rows() RETURNS trigger AS $$
BEGIN
  IF NEW."is_paper" THEN
    RAISE EXCEPTION 'Paper trading is retired: % rows cannot be paper', TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER assets_no_new_paper BEFORE INSERT ON "assets"
  FOR EACH ROW EXECUTE FUNCTION no_new_paper_rows();
CREATE TRIGGER markets_no_new_paper BEFORE INSERT ON "markets"
  FOR EACH ROW EXECUTE FUNCTION no_new_paper_rows();

CREATE OR REPLACE FUNCTION journal_entries_no_paper_grants() RETURNS trigger AS $$
BEGIN
  IF NEW."type"::text = 'PAPER_FAUCET_GRANT' THEN
    RAISE EXCEPTION 'Paper trading is retired: no faucet grants'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER journal_entries_no_paper_grants BEFORE INSERT ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION journal_entries_no_paper_grants();

UPDATE "markets" SET "status" = 'HALTED' WHERE "is_paper" AND "status" = 'ACTIVE';

-- Perpetuals on real collateral. A paper asset can still not be combined with
-- a real one (markets namespace trigger, ADR-0010).
ALTER TABLE "markets" DROP CONSTRAINT "markets_perp_paper_only_chk";

CREATE OR REPLACE FUNCTION ledger_accounts_check_namespace() RETURNS trigger AS $$
DECLARE paper BOOLEAN; chain_token CHAR(42);
BEGIN
  SELECT "is_paper", "chain_token_address" INTO paper, chain_token FROM "assets" WHERE "id" = NEW."asset_id";
  IF NEW."type"::text = 'PAPER_FAUCET' AND NOT paper THEN
    RAISE EXCEPTION 'PAPER_FAUCET accounts are only allowed for paper assets' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."type"::text = 'SIMULATED_CUSTODY' AND (paper OR chain_token IS NOT NULL) THEN
    RAISE EXCEPTION 'SIMULATED_CUSTODY accounts are only allowed for real assets without a chain token' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."type"::text IN ('VAULT_CUSTODY', 'USER_WITHDRAWING') AND chain_token IS NULL THEN
    RAISE EXCEPTION '% accounts are only allowed for chain-backed assets', NEW."type" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
