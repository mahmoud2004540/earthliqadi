-- Leader vaults / copy-trading (ADR-0019).
ALTER TYPE "JournalEntryType" ADD VALUE 'VAULT_DEPOSIT';
ALTER TYPE "JournalEntryType" ADD VALUE 'VAULT_REDEMPTION';

-- The engine's self-trade-prevention account. A parent account, its
-- sub-accounts and its leader vaults share one, so a leader can never trade
-- against their own vault. Liquidation orders keep the user's own id.
ALTER TABLE "orders" ADD COLUMN "engine_account" UUID;

-- A vault's trading account: credential-free, owned by the leader for
-- trading only (X-Sub-Account), never part of the leader's balance leaf.
ALTER TABLE "users" ADD COLUMN "is_vault" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD CONSTRAINT "users_vault_chk" CHECK (NOT "is_vault" OR "parent_user_id" IS NOT NULL);

CREATE TABLE "leader_vaults" (
  "id" UUID NOT NULL,
  "leader_user_id" UUID NOT NULL,
  "account_user_id" UUID NOT NULL,
  "name" VARCHAR(48) NOT NULL,
  "description" VARCHAR(280) NOT NULL DEFAULT '',
  "quote_asset_id" UUID NOT NULL,
  "profit_share_bps" INTEGER NOT NULL,
  "min_leader_share_bps" INTEGER NOT NULL DEFAULT 500,
  "max_leverage" INTEGER NOT NULL,
  "max_drawdown_bps" INTEGER NOT NULL,
  "status" VARCHAR(12) NOT NULL DEFAULT 'OPEN',
  "peak_pps_e18" DECIMAL(78,0) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "leader_vaults_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "leader_vaults_values_chk" CHECK (
    "profit_share_bps" BETWEEN 0 AND 3000 AND "min_leader_share_bps" BETWEEN 100 AND 10000
    AND "max_leverage" BETWEEN 1 AND 50 AND "max_drawdown_bps" BETWEEN 100 AND 9000
    AND "status" IN ('OPEN', 'HALTED', 'CLOSED') AND "peak_pps_e18" > 0)
);
CREATE UNIQUE INDEX "leader_vaults_account_user_id_key" ON "leader_vaults"("account_user_id");
CREATE UNIQUE INDEX "leader_vaults_name_key" ON "leader_vaults"(lower("name"));
CREATE INDEX "leader_vaults_leader_user_id_idx" ON "leader_vaults"("leader_user_id");
ALTER TABLE "leader_vaults" ADD CONSTRAINT "leader_vaults_leader_fkey" FOREIGN KEY ("leader_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leader_vaults" ADD CONSTRAINT "leader_vaults_account_fkey" FOREIGN KEY ("account_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leader_vaults" ADD CONSTRAINT "leader_vaults_asset_fkey" FOREIGN KEY ("quote_asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The terms followers joined under can never be changed (profit share,
-- leader minimum, owner, account, asset). Limits may only get stricter.
CREATE OR REPLACE FUNCTION leader_vaults_terms_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."leader_user_id" IS DISTINCT FROM OLD."leader_user_id" OR NEW."account_user_id" IS DISTINCT FROM OLD."account_user_id"
     OR NEW."quote_asset_id" IS DISTINCT FROM OLD."quote_asset_id" OR NEW."profit_share_bps" IS DISTINCT FROM OLD."profit_share_bps"
     OR NEW."min_leader_share_bps" IS DISTINCT FROM OLD."min_leader_share_bps" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."max_leverage" > OLD."max_leverage" OR NEW."max_drawdown_bps" > OLD."max_drawdown_bps" THEN
    RAISE EXCEPTION 'vault terms are fixed (limits may only become stricter)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER leader_vaults_terms_immutable BEFORE UPDATE ON "leader_vaults"
  FOR EACH ROW EXECUTE FUNCTION leader_vaults_terms_immutable();

-- Share units per holder. hwm_e18: price per share above which profit share
-- is charged (per holder, set at deposit, raised when profit share is taken).
CREATE TABLE "vault_shares" (
  "vault_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "shares" DECIMAL(38,0) NOT NULL,
  "hwm_e18" DECIMAL(78,0) NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vault_shares_pkey" PRIMARY KEY ("vault_id", "user_id"),
  CONSTRAINT "vault_shares_chk" CHECK ("shares" >= 0 AND "hwm_e18" > 0)
);
ALTER TABLE "vault_shares" ADD CONSTRAINT "vault_shares_vault_fkey" FOREIGN KEY ("vault_id") REFERENCES "leader_vaults"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vault_shares" ADD CONSTRAINT "vault_shares_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exits are never refused: a redemption that free collateral cannot cover yet
-- is queued, and the vault cannot add risk until it is paid.
CREATE TABLE "vault_redemptions" (
  "id" UUID NOT NULL,
  "vault_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "shares" DECIMAL(38,0) NOT NULL,
  "status" VARCHAR(10) NOT NULL DEFAULT 'PENDING',
  "amount" DECIMAL(38,0),
  "profit_share" DECIMAL(38,0),
  "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paid_at" TIMESTAMPTZ(3),
  CONSTRAINT "vault_redemptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vault_redemptions_chk" CHECK ("shares" > 0 AND "status" IN ('PENDING', 'PAID'))
);
CREATE INDEX "vault_redemptions_pending_idx" ON "vault_redemptions"("vault_id", "requested_at") WHERE "status" = 'PENDING';
ALTER TABLE "vault_redemptions" ADD CONSTRAINT "vault_redemptions_vault_fkey" FOREIGN KEY ("vault_id") REFERENCES "leader_vaults"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Track record: equity and price per share over time, derived from the ledger.
CREATE TABLE "vault_snapshots" (
  "vault_id" UUID NOT NULL,
  "at" TIMESTAMPTZ(3) NOT NULL,
  "equity" DECIMAL(38,0) NOT NULL,
  "total_shares" DECIMAL(38,0) NOT NULL,
  "pps_e18" DECIMAL(78,0) NOT NULL,
  CONSTRAINT "vault_snapshots_pkey" PRIMARY KEY ("vault_id", "at")
);
ALTER TABLE "vault_snapshots" ADD CONSTRAINT "vault_snapshots_vault_fkey" FOREIGN KEY ("vault_id") REFERENCES "leader_vaults"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
