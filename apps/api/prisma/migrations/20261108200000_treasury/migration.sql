-- Treasury withdrawals of fee revenue (ADR-0031).
ALTER TYPE "LedgerAccountType" ADD VALUE 'TREASURY_WITHDRAWING';

-- Like USER_WITHDRAWING, the treasury hold only exists for chain-backed assets.
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
  IF NEW."type"::text IN ('VAULT_CUSTODY', 'USER_WITHDRAWING', 'TREASURY_WITHDRAWING') AND chain_token IS NULL THEN
    RAISE EXCEPTION '% accounts are only allowed for chain-backed assets', NEW."type" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A treasury withdrawal has no customer: it pays the configured treasury
-- wallet and always comes from an approved maker-checker request.
ALTER TABLE "withdrawals" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "withdrawals"
  ADD COLUMN "is_treasury" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "approval_id" UUID REFERENCES "approval_requests" ("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_treasury_chk" CHECK (
  ("is_treasury" = ("user_id" IS NULL)) AND ("is_treasury" = ("approval_id" IS NOT NULL)));
CREATE UNIQUE INDEX "withdrawals_approval_uniq" ON "withdrawals" ("approval_id") WHERE "approval_id" IS NOT NULL;
