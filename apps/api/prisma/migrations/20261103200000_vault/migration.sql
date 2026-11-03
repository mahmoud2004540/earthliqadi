-- Non-custodial vault integration (ADR-0014). Testnet / local chain only.
ALTER TYPE "LedgerAccountType" ADD VALUE 'VAULT_CUSTODY';
ALTER TYPE "LedgerAccountType" ADD VALUE 'USER_WITHDRAWING';
ALTER TYPE "JournalEntryType" ADD VALUE 'CHAIN_DEPOSIT';
ALTER TYPE "JournalEntryType" ADD VALUE 'WITHDRAWAL_HOLD';
ALTER TYPE "JournalEntryType" ADD VALUE 'WITHDRAWAL_FINAL';
ALTER TYPE "JournalEntryType" ADD VALUE 'WITHDRAWAL_RELEASE';

CREATE TYPE "WithdrawalStatus" AS ENUM ('SIGNED', 'EXECUTED', 'EXPIRED');
CREATE TYPE "VaultStateStatus" AS ENUM ('PENDING', 'COMMITTED');

-- A real asset may be backed by an ERC-20 held in the vault. Immutable once set.
ALTER TABLE "assets" ADD COLUMN "chain_token_address" CHAR(42);
CREATE UNIQUE INDEX "assets_chain_token_address_key" ON "assets"("chain_token_address");
ALTER TABLE "assets" ADD CONSTRAINT "assets_chain_token_chk" CHECK (
  "chain_token_address" IS NULL OR ("chain_token_address" ~ '^0x[0-9a-f]{40}$' AND NOT "is_paper"));
CREATE OR REPLACE FUNCTION assets_chain_token_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."chain_token_address" IS NOT NULL AND NEW."chain_token_address" IS DISTINCT FROM OLD."chain_token_address" THEN
    RAISE EXCEPTION 'asset chain token is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER assets_chain_token_immutable BEFORE UPDATE ON "assets"
  FOR EACH ROW EXECUTE FUNCTION assets_chain_token_immutable();

-- USER_WITHDRAWING is user-owned.
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_owner_chk";
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_chk" CHECK (
  ("type"::text IN ('USER_AVAILABLE', 'USER_LOCKED', 'USER_MARGIN', 'USER_WITHDRAWING') AND "owner_user_id" IS NOT NULL AND "owner_key" = "owner_user_id"::text)
  OR ("type"::text NOT IN ('USER_AVAILABLE', 'USER_LOCKED', 'USER_MARGIN', 'USER_WITHDRAWING') AND "owner_user_id" IS NULL AND "owner_key" = 'system'));

-- Vault custody accounts only for chain-backed (real) assets.
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
  IF NEW."type"::text IN ('USER_MARGIN', 'PERP_CLEARING', 'INSURANCE_FUND', 'PERP_FUNDING_POOL') AND NOT paper THEN
    RAISE EXCEPTION '% accounts are only allowed for paper assets (derivatives are paper-only)', NEW."type" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Which vault this deployment talks to (one row per chain).
CREATE TABLE "chain_deployments" (
  "chain_id" INTEGER NOT NULL,
  "vault_address" CHAR(42) NOT NULL,
  "operator_address" CHAR(42) NOT NULL,
  "deploy_block" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chain_deployments_pkey" PRIMARY KEY ("chain_id")
);

-- Indexer progress: every event up to last_block is reflected in the ledger.
CREATE TABLE "chain_cursors" (
  "chain_id" INTEGER NOT NULL,
  "last_block" BIGINT NOT NULL,
  "last_block_hash" CHAR(66),
  "last_block_time" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "chain_cursors_pkey" PRIMARY KEY ("chain_id")
);

CREATE TABLE "chain_deposits" (
  "chain_id" INTEGER NOT NULL,
  "vault_address" CHAR(42) NOT NULL,
  "deposit_id" BIGINT NOT NULL,
  "tx_hash" CHAR(66) NOT NULL,
  "log_index" INTEGER NOT NULL,
  "block_number" BIGINT NOT NULL,
  "block_hash" CHAR(66) NOT NULL,
  "wallet_address" CHAR(42) NOT NULL,
  "asset_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "amount" DECIMAL(38,0) NOT NULL,
  "journal_entry_id" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chain_deposits_pkey" PRIMARY KEY ("chain_id", "vault_address", "deposit_id"),
  CONSTRAINT "chain_deposits_amount_chk" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "chain_deposits_tx_log_key" ON "chain_deposits"("chain_id", "tx_hash", "log_index");
CREATE INDEX "chain_deposits_user_id_idx" ON "chain_deposits"("user_id");
ALTER TABLE "chain_deposits" ADD CONSTRAINT "chain_deposits_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chain_deposits" ADD CONSTRAINT "chain_deposits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "withdrawals" (
  "id" CHAR(66) NOT NULL,
  "chain_id" INTEGER NOT NULL,
  "vault_address" CHAR(42) NOT NULL,
  "user_id" UUID NOT NULL,
  "asset_id" UUID NOT NULL,
  "wallet_address" CHAR(42) NOT NULL,
  "amount" DECIMAL(38,0) NOT NULL,
  "after_state" BIGINT NOT NULL,
  "expiry" TIMESTAMPTZ(3) NOT NULL,
  "signature" CHAR(132) NOT NULL,
  "status" "WithdrawalStatus" NOT NULL DEFAULT 'SIGNED',
  "tx_hash" CHAR(66),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finalised_at" TIMESTAMPTZ(3),
  CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "withdrawals_amount_chk" CHECK ("amount" > 0)
);
CREATE INDEX "withdrawals_user_id_created_at_idx" ON "withdrawals"("user_id", "created_at");
CREATE INDEX "withdrawals_status_expiry_idx" ON "withdrawals"("status", "expiry");
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Balance snapshots committed on-chain (Merkle roots). Leaves let users prove their balance.
CREATE TABLE "vault_states" (
  "chain_id" INTEGER NOT NULL,
  "vault_address" CHAR(42) NOT NULL,
  "index" BIGINT NOT NULL,
  "root" CHAR(66) NOT NULL,
  "last_deposit_id" BIGINT NOT NULL,
  "leaf_count" INTEGER NOT NULL,
  "status" "VaultStateStatus" NOT NULL DEFAULT 'PENDING',
  "tx_hash" CHAR(66),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committed_at" TIMESTAMPTZ(3),
  CONSTRAINT "vault_states_pkey" PRIMARY KEY ("chain_id", "vault_address", "index")
);
CREATE TABLE "vault_state_leaves" (
  "chain_id" INTEGER NOT NULL,
  "vault_address" CHAR(42) NOT NULL,
  "index" BIGINT NOT NULL,
  "wallet_address" CHAR(42) NOT NULL,
  "token_address" CHAR(42) NOT NULL,
  "balance" DECIMAL(78,0) NOT NULL,
  CONSTRAINT "vault_state_leaves_pkey" PRIMARY KEY ("chain_id", "vault_address", "index", "wallet_address", "token_address")
);
ALTER TABLE "vault_state_leaves" ADD CONSTRAINT "vault_state_leaves_state_fkey" FOREIGN KEY ("chain_id", "vault_address", "index") REFERENCES "vault_states"("chain_id", "vault_address", "index") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER vault_state_leaves_immutable BEFORE UPDATE OR DELETE ON "vault_state_leaves"
  FOR EACH ROW EXECUTE FUNCTION perp_history_immutable();
