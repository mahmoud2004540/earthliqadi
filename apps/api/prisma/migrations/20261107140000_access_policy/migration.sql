-- Access policy (ADR-0022): terms acceptance and a sanctioned-address list.
ALTER TABLE "users" ADD COLUMN "terms_accepted_version" VARCHAR(32);
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" TIMESTAMPTZ(3);
ALTER TABLE "users" ADD CONSTRAINT "users_terms_accepted_chk"
  CHECK (("terms_accepted_version" IS NULL) = ("terms_accepted_at" IS NULL));

-- Loaded by operators from official lists (CLI `sanctions import`); never seeded by code.
CREATE TABLE "sanctioned_addresses" (
  "address"  CHAR(42)       NOT NULL,
  "source"   VARCHAR(64)    NOT NULL,
  "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sanctioned_addresses_pkey" PRIMARY KEY ("address", "source"),
  CONSTRAINT "sanctioned_addresses_address_chk" CHECK ("address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "sanctioned_addresses_source_chk" CHECK ("source" ~ '^[A-Za-z0-9._-]{1,64}$')
);
CREATE INDEX "sanctioned_addresses_address_idx" ON "sanctioned_addresses" ("address");
