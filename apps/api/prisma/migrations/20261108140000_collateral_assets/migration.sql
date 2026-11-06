-- Multi-collateral by auto-conversion (ADR-0027).
CREATE TABLE "collateral_assets" (
  "asset_id"       UUID NOT NULL REFERENCES "assets" ("id") ON DELETE RESTRICT,
  -- The spot market (asset / quote) that converts it.
  "spot_market_id" UUID NOT NULL REFERENCES "markets" ("id") ON DELETE RESTRICT,
  "haircut_bps"    INTEGER NOT NULL,
  "enabled"        BOOLEAN NOT NULL DEFAULT true,
  "updated_by"     UUID NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "updated_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "collateral_assets_pkey" PRIMARY KEY ("asset_id"),
  CONSTRAINT "collateral_assets_haircut_chk" CHECK ("haircut_bps" BETWEEN 100 AND 5000)
);

-- Opt-in per account: pledged balances may be sold to defend cross positions.
ALTER TABLE "users" ADD COLUMN "perp_collateral_enabled" BOOLEAN NOT NULL DEFAULT false;
