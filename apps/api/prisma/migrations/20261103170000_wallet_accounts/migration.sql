-- Wallet sign-in (SIWE, ADR-0013): customer accounts are identified by an
-- Ethereum address, without email or password. Staff keep email + password + MFA.
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL,
                    ALTER COLUMN "password_hash" DROP NOT NULL,
                    ADD COLUMN "wallet_address" CHAR(42);
CREATE UNIQUE INDEX "users_wallet_address_key" ON "users"("wallet_address");
-- Stored lower-case; display uses EIP-55 checksums.
ALTER TABLE "users" ADD CONSTRAINT "users_wallet_address_chk"
  CHECK ("wallet_address" IS NULL OR "wallet_address" ~ '^0x[0-9a-f]{40}$');
-- Every account has a way to sign in: email + password, or a wallet.
ALTER TABLE "users" ADD CONSTRAINT "users_credential_chk" CHECK (
  ("email" IS NOT NULL AND "password_hash" IS NOT NULL) OR "wallet_address" IS NOT NULL);
-- A wallet identity can never be reassigned to another account.
CREATE OR REPLACE FUNCTION users_wallet_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."wallet_address" IS NOT NULL AND NEW."wallet_address" IS DISTINCT FROM OLD."wallet_address" THEN
    RAISE EXCEPTION 'wallet address is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER users_wallet_immutable BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_wallet_immutable();
