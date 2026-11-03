-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('USER_AVAILABLE', 'USER_LOCKED', 'FEE_REVENUE', 'SUSPENSE', 'SIMULATED_CUSTODY');

-- CreateEnum
CREATE TYPE "PostingDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "JournalEntryType" AS ENUM ('SIMULATED_DEPOSIT', 'BALANCE_HOLD', 'BALANCE_RELEASE', 'REVERSAL');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('OK', 'MISMATCH');

-- CreateEnum
CREATE TYPE "ReconciliationTrigger" AS ENUM ('SCHEDULED', 'MANUAL', 'CLI');

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "scale" INTEGER NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "owner_user_id" UUID,
    "owner_key" VARCHAR(36) NOT NULL,
    "normal_side" "PostingDirection" NOT NULL,
    "allow_negative" BOOLEAN NOT NULL DEFAULT false,
    "balance" DECIMAL(38,0) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" BIGSERIAL NOT NULL,
    "type" "JournalEntryType" NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "description" VARCHAR(256) NOT NULL,
    "reverses_entry_id" BIGINT,
    "actor_type" "ActorType" NOT NULL,
    "actor_user_id" UUID,
    "request_id" VARCHAR(64),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "postings" (
    "id" BIGSERIAL NOT NULL,
    "entry_id" BIGINT NOT NULL,
    "account_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "direction" "PostingDirection" NOT NULL,
    "amount" DECIMAL(38,0) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_reconciliation_runs" (
    "id" UUID NOT NULL,
    "trigger" "ReconciliationTrigger" NOT NULL,
    "status" "ReconciliationStatus" NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3) NOT NULL,
    "accounts_checked" INTEGER NOT NULL,
    "entries_checked" INTEGER NOT NULL,
    "findings" JSONB NOT NULL DEFAULT '[]',
    "actor_user_id" UUID,

    CONSTRAINT "ledger_reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assets_code_key" ON "assets"("code");

-- CreateIndex
CREATE INDEX "ledger_accounts_owner_user_id_idx" ON "ledger_accounts"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_asset_id_type_owner_key_key" ON "ledger_accounts"("asset_id", "type", "owner_key");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_idempotency_key_key" ON "journal_entries"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reverses_entry_id_key" ON "journal_entries"("reverses_entry_id");

-- CreateIndex
CREATE INDEX "journal_entries_type_created_at_idx" ON "journal_entries"("type", "created_at");

-- CreateIndex
CREATE INDEX "postings_entry_id_idx" ON "postings"("entry_id");

-- CreateIndex
CREATE INDEX "postings_account_id_id_idx" ON "postings"("account_id", "id");

-- CreateIndex
CREATE INDEX "ledger_reconciliation_runs_started_at_idx" ON "ledger_reconciliation_runs"("started_at");

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_entry_id_fkey" FOREIGN KEY ("reverses_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postings" ADD CONSTRAINT "postings_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postings" ADD CONSTRAINT "postings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postings" ADD CONSTRAINT "postings_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Ledger invariants enforced by the database (ADR-0006).
-- These hold even if application code is wrong.
-- ===========================================================================

-- --- assets -----------------------------------------------------------------
ALTER TABLE "assets" ADD CONSTRAINT "assets_code_format_chk" CHECK ("code" ~ '^[A-Z0-9]{2,16}$');
ALTER TABLE "assets" ADD CONSTRAINT "assets_scale_chk" CHECK ("scale" BETWEEN 0 AND 18);

-- Scale defines what stored amounts mean; changing it would silently rescale history.
CREATE OR REPLACE FUNCTION assets_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW."scale" IS DISTINCT FROM OLD."scale" OR NEW."code" IS DISTINCT FROM OLD."code" THEN
    RAISE EXCEPTION 'asset code and scale are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER assets_guard_update BEFORE UPDATE ON "assets"
  FOR EACH ROW EXECUTE FUNCTION assets_guard_update();

-- --- ledger_accounts ----------------------------------------------------------
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_non_negative_chk"
  CHECK ("allow_negative" OR "balance" >= 0);
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_chk" CHECK (
  ("type" IN ('USER_AVAILABLE', 'USER_LOCKED') AND "owner_user_id" IS NOT NULL AND "owner_key" = "owner_user_id"::text)
  OR ("type" NOT IN ('USER_AVAILABLE', 'USER_LOCKED') AND "owner_user_id" IS NULL AND "owner_key" = 'system')
);
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_balance_range_chk"
  CHECK ("balance" > -1e38 AND "balance" < 1e38);

-- Balance changes only through postings; identity columns never change.
CREATE OR REPLACE FUNCTION ledger_accounts_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."balance" <> 0 THEN
      RAISE EXCEPTION 'ledger accounts must be created with a zero balance' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger accounts cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."asset_id" IS DISTINCT FROM OLD."asset_id" OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id" OR NEW."owner_key" IS DISTINCT FROM OLD."owner_key"
     OR NEW."normal_side" IS DISTINCT FROM OLD."normal_side" OR NEW."allow_negative" IS DISTINCT FROM OLD."allow_negative" THEN
    RAISE EXCEPTION 'ledger account identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."balance" IS DISTINCT FROM OLD."balance"
     AND current_setting('ledger.applying_posting', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'ledger balances can only change through postings' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION ledger_accounts_guard();

-- --- postings: positive amounts, balance projection ---------------------------
ALTER TABLE "postings" ADD CONSTRAINT "postings_amount_positive_chk" CHECK ("amount" > 0);

CREATE OR REPLACE FUNCTION ledger_apply_posting() RETURNS trigger AS $$
DECLARE
  acc "ledger_accounts"%ROWTYPE;
BEGIN
  SELECT * INTO acc FROM "ledger_accounts" WHERE "id" = NEW."account_id" FOR UPDATE;
  IF acc."asset_id" <> NEW."asset_id" THEN
    RAISE EXCEPTION 'posting asset does not match account asset' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM set_config('ledger.applying_posting', 'on', true);
  UPDATE "ledger_accounts"
     SET "balance" = "balance" + CASE WHEN NEW."direction" = acc."normal_side" THEN NEW."amount" ELSE -NEW."amount" END,
         "updated_at" = now()
   WHERE "id" = NEW."account_id";
  PERFORM set_config('ledger.applying_posting', 'off', true);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER postings_apply AFTER INSERT ON "postings"
  FOR EACH ROW EXECUTE FUNCTION ledger_apply_posting();

-- --- journal entries balanced per asset (checked at COMMIT) ---------------------
CREATE OR REPLACE FUNCTION ledger_check_entry_balanced() RETURNS trigger AS $$
DECLARE
  target BIGINT;
  posting_count INT;
  unbalanced INT;
BEGIN
  -- NEW has different columns per table; branch with IF (CASE would resolve both).
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target := NEW."id";
  ELSE
    target := NEW."entry_id";
  END IF;
  SELECT count(*) INTO posting_count FROM "postings" WHERE "entry_id" = target;
  IF posting_count < 2 THEN
    RAISE EXCEPTION 'journal entry % has fewer than two postings', target USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT count(*) INTO unbalanced FROM (
    SELECT "asset_id" FROM "postings" WHERE "entry_id" = target
    GROUP BY "asset_id"
    HAVING sum(CASE WHEN "direction" = 'DEBIT' THEN "amount" ELSE -"amount" END) <> 0
  ) s;
  IF unbalanced > 0 THEN
    RAISE EXCEPTION 'journal entry % is not balanced per asset', target USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_entry_balanced();
CREATE CONSTRAINT TRIGGER postings_balanced AFTER INSERT ON "postings"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_entry_balanced();

-- --- immutability --------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is immutable: % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON "journal_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_block_mutation();
CREATE TRIGGER postings_immutable BEFORE UPDATE OR DELETE ON "postings"
  FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();
CREATE TRIGGER postings_no_truncate BEFORE TRUNCATE ON "postings"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_block_mutation();
CREATE TRIGGER ledger_accounts_no_truncate BEFORE TRUNCATE ON "ledger_accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_block_mutation();
CREATE TRIGGER ledger_reconciliation_runs_immutable BEFORE UPDATE OR DELETE ON "ledger_reconciliation_runs"
  FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();
CREATE TRIGGER ledger_reconciliation_runs_no_truncate BEFORE TRUNCATE ON "ledger_reconciliation_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_block_mutation();

-- A reversal must not reverse itself.
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_chk"
  CHECK ("reverses_entry_id" IS NULL OR "reverses_entry_id" <> "id");
