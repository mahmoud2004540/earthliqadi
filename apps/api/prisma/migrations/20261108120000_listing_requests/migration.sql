-- Listing request board (ADR-0026): public requests and votes for new markets.
CREATE TABLE "listing_requests" (
  "id"               UUID NOT NULL,
  "author_user_id"   UUID NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "base_symbol"      VARCHAR(16) NOT NULL,
  "base_name"        VARCHAR(64) NOT NULL,
  "kind"             VARCHAR(10) NOT NULL,
  "quote_asset_code" VARCHAR(16) NOT NULL,
  "chain_id"         INTEGER,
  "token_address"    CHAR(42),
  "rationale"        VARCHAR(1000) NOT NULL,
  "link"             VARCHAR(200),
  "status"           VARCHAR(12) NOT NULL DEFAULT 'OPEN',
  "decision_note"    VARCHAR(500),
  "decided_by"       UUID REFERENCES "users" ("id") ON DELETE RESTRICT,
  "decided_at"       TIMESTAMPTZ(3),
  "market_id"        UUID REFERENCES "markets" ("id") ON DELETE RESTRICT,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "listing_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "listing_requests_chk" CHECK (
    "base_symbol" ~ '^[A-Z0-9]{2,16}$'
    AND "kind" IN ('SPOT', 'PERPETUAL')
    AND "status" IN ('OPEN', 'REVIEW', 'LISTED', 'REJECTED', 'WITHDRAWN')
    AND ("token_address" IS NULL OR "token_address" ~ '^0x[0-9a-f]{40}$')
    AND (("token_address" IS NULL) = ("chain_id" IS NULL))
    AND ("link" IS NULL OR "link" ~ '^https://')
    -- Decisions are explained and attributed; a listing names its market.
    AND (("status" IN ('LISTED', 'REJECTED')) = ("decided_at" IS NOT NULL AND "decision_note" IS NOT NULL AND "decided_by" IS NOT NULL))
    AND (("status" = 'LISTED') = ("market_id" IS NOT NULL)))
);
-- One live request per market idea.
CREATE UNIQUE INDEX "listing_requests_live_uniq"
  ON "listing_requests" ("base_symbol", "kind", "quote_asset_code")
  WHERE "status" IN ('OPEN', 'REVIEW');
CREATE INDEX "listing_requests_author_idx" ON "listing_requests" ("author_user_id", "created_at");
CREATE INDEX "listing_requests_status_idx" ON "listing_requests" ("status", "created_at");

CREATE TABLE "listing_votes" (
  "request_id" UUID NOT NULL REFERENCES "listing_requests" ("id") ON DELETE CASCADE,
  "user_id"    UUID NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  -- Whether the voter had traded when voting (only these rank the board).
  "eligible"   BOOLEAN NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "listing_votes_pkey" PRIMARY KEY ("request_id", "user_id")
);
CREATE INDEX "listing_votes_user_idx" ON "listing_votes" ("user_id");
