-- Professional tooling (ADR-0017): agent API keys and the dead-man switch.

-- Agent API keys: Ed25519 public keys authorised by the account's wallet
-- signature. Only the public key is stored; the private key never reaches us.
-- Scopes are read/trade only: there is no scope that can withdraw.
CREATE TABLE "api_keys" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "label" VARCHAR(48) NOT NULL,
  "public_key" CHAR(64) NOT NULL,
  "scopes" TEXT[] NOT NULL,
  "allowed_ips" TEXT[] NOT NULL DEFAULT '{}',
  "authorization_message" TEXT NOT NULL,
  "authorization_signature" VARCHAR(132) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "last_used_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "api_keys_public_key_chk" CHECK ("public_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "api_keys_scopes_chk" CHECK (
    cardinality("scopes") > 0 AND "scopes" <@ ARRAY['read', 'trade']::TEXT[]),
  CONSTRAINT "api_keys_expiry_chk" CHECK ("expires_at" > "created_at")
);
CREATE UNIQUE INDEX "api_keys_public_key_key" ON "api_keys"("public_key");
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What was authorised can never change; only last use and revocation can.
CREATE OR REPLACE FUNCTION api_keys_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."user_id" IS DISTINCT FROM OLD."user_id" OR NEW."public_key" IS DISTINCT FROM OLD."public_key"
     OR NEW."scopes" IS DISTINCT FROM OLD."scopes" OR NEW."allowed_ips" IS DISTINCT FROM OLD."allowed_ips"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."authorization_message" IS DISTINCT FROM OLD."authorization_message"
     OR NEW."authorization_signature" IS DISTINCT FROM OLD."authorization_signature"
     OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at") THEN
    RAISE EXCEPTION 'api key authorisation is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER api_keys_immutable BEFORE UPDATE ON "api_keys"
  FOR EACH ROW EXECUTE FUNCTION api_keys_immutable();

-- Dead-man switch: when the deadline passes without a refresh, every open
-- order of the user is cancelled.
CREATE TABLE "cancel_all_timers" (
  "user_id" UUID NOT NULL,
  "deadline" TIMESTAMPTZ(3) NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cancel_all_timers_pkey" PRIMARY KEY ("user_id")
);
CREATE INDEX "cancel_all_timers_deadline_idx" ON "cancel_all_timers"("deadline");
ALTER TABLE "cancel_all_timers" ADD CONSTRAINT "cancel_all_timers_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
