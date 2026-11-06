-- RFQ / block trades (ADR-0020).
ALTER TABLE "engine_commands" DROP CONSTRAINT "engine_commands_kind_chk";
ALTER TABLE "engine_commands" ADD CONSTRAINT "engine_commands_kind_chk" CHECK ("kind" IN ('place', 'cancel', 'reduce', 'block'));

-- Accounts allowed to answer requests for quote (registered by staff, public terms).
CREATE TABLE "rfq_makers" (
  "user_id" UUID NOT NULL,
  "registered_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ(3),
  CONSTRAINT "rfq_makers_pkey" PRIMARY KEY ("user_id")
);
ALTER TABLE "rfq_makers" ADD CONSTRAINT "rfq_makers_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "rfq_requests" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "market_id" UUID NOT NULL,
  "side" "OrderSide" NOT NULL,
  "quantity_lots" BIGINT NOT NULL,
  "status" VARCHAR(10) NOT NULL DEFAULT 'OPEN',
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "accepted_quote_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rfq_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rfq_requests_chk" CHECK ("quantity_lots" > 0 AND "status" IN ('OPEN', 'FILLED', 'CANCELLED'))
);
CREATE INDEX "rfq_requests_open_idx" ON "rfq_requests"("expires_at") WHERE "status" = 'OPEN';
ALTER TABLE "rfq_requests" ADD CONSTRAINT "rfq_requests_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rfq_requests" ADD CONSTRAINT "rfq_requests_market_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "rfq_quotes" (
  "id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "maker_user_id" UUID NOT NULL,
  "price_ticks" BIGINT NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rfq_quotes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rfq_quotes_price_chk" CHECK ("price_ticks" > 0)
);
CREATE UNIQUE INDEX "rfq_quotes_request_maker_key" ON "rfq_quotes"("request_id", "maker_user_id");
ALTER TABLE "rfq_quotes" ADD CONSTRAINT "rfq_quotes_request_fkey" FOREIGN KEY ("request_id") REFERENCES "rfq_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rfq_quotes" ADD CONSTRAINT "rfq_quotes_maker_fkey" FOREIGN KEY ("maker_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
