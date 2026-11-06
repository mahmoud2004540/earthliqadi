-- Sub-accounts (ADR-0017 part 2): separate balances, orders and positions
-- under one wallet. A sub-account has no credentials of its own: it is only
-- ever used by its parent's session or API keys, and its balances belong to
-- the parent's wallet in the vault state (claimable through the escape hatch).
ALTER TYPE "JournalEntryType" ADD VALUE 'INTERNAL_TRANSFER';

ALTER TABLE "users" ADD COLUMN "parent_user_id" UUID,
                    ADD COLUMN "label" VARCHAR(48);
ALTER TABLE "users" ADD CONSTRAINT "users_parent_user_id_fkey"
  FOREIGN KEY ("parent_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "users_parent_user_id_idx" ON "users"("parent_user_id");

ALTER TABLE "users" DROP CONSTRAINT "users_credential_chk";
ALTER TABLE "users" ADD CONSTRAINT "users_credential_chk" CHECK (
  ("parent_user_id" IS NULL AND (("email" IS NOT NULL AND "password_hash" IS NOT NULL) OR "wallet_address" IS NOT NULL))
  OR ("parent_user_id" IS NOT NULL AND "email" IS NULL AND "password_hash" IS NULL
      AND "wallet_address" IS NULL AND "label" IS NOT NULL));

-- One level only, the parent must be a wallet account, and the link is permanent.
CREATE OR REPLACE FUNCTION users_parent_check() RETURNS trigger AS $$
DECLARE p_parent UUID; p_wallet CHAR(42);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."parent_user_id" IS DISTINCT FROM OLD."parent_user_id" THEN
    RAISE EXCEPTION 'sub-account parent is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."parent_user_id" IS NOT NULL THEN
    SELECT "parent_user_id", "wallet_address" INTO p_parent, p_wallet FROM "users" WHERE "id" = NEW."parent_user_id";
    IF p_parent IS NOT NULL OR p_wallet IS NULL THEN
      RAISE EXCEPTION 'a sub-account parent must be a wallet account that is not itself a sub-account'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER users_parent_check BEFORE INSERT OR UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_parent_check();
