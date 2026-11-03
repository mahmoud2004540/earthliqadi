-- Phase 7: maker-checker approvals, KYC cases, notifications, support, announcements (ADR-0012).
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'NEEDS_INFO');
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'WAITING_ON_USER', 'CLOSED');

ALTER TABLE "users" ADD COLUMN "kyc_level" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD CONSTRAINT "users_kyc_level_chk" CHECK ("kyc_level" BETWEEN 0 AND 2);

-- Maker-checker: every request needs a DIFFERENT approver.
CREATE TABLE "approval_requests" (
  "id" UUID NOT NULL,
  "action" VARCHAR(48) NOT NULL,
  "payload" JSONB NOT NULL,
  "reason" VARCHAR(256) NOT NULL,
  "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "requested_by_id" UUID NOT NULL,
  "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "decided_by_id" UUID,
  "decided_at" TIMESTAMPTZ(3),
  "decision_note" VARCHAR(256),
  "result" JSONB,
  CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "approval_requests_four_eyes_chk" CHECK ("decided_by_id" IS NULL OR "decided_by_id" <> "requested_by_id"),
  CONSTRAINT "approval_requests_decision_chk" CHECK (("status" = 'PENDING') = ("decided_at" IS NULL))
);
CREATE INDEX "approval_requests_status_requested_at_idx" ON "approval_requests"("status", "requested_at");
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A request is decided exactly once; what was requested can never change.
CREATE OR REPLACE FUNCTION approval_requests_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval requests are append-only' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'approval request % is already decided', OLD."id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."action" IS DISTINCT FROM OLD."action" OR NEW."payload" IS DISTINCT FROM OLD."payload"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."requested_by_id" IS DISTINCT FROM OLD."requested_by_id"
     OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at" OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    RAISE EXCEPTION 'approval request contents are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER approval_requests_guard BEFORE UPDATE OR DELETE ON "approval_requests"
  FOR EACH ROW EXECUTE FUNCTION approval_requests_guard();

CREATE TABLE "kyc_cases" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "level" INTEGER NOT NULL,
  "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
  -- AES-256-GCM encrypted JSON profile (legal name, date of birth, address). Never logged.
  "profile_enc" BYTEA NOT NULL,
  "country_code" CHAR(2) NOT NULL,
  "screening" JSONB NOT NULL,
  "reviewer_id" UUID,
  "decision_note" VARCHAR(512),
  "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMPTZ(3),
  CONSTRAINT "kyc_cases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "kyc_cases_level_chk" CHECK ("level" BETWEEN 1 AND 2),
  CONSTRAINT "kyc_cases_reviewer_chk" CHECK ("reviewer_id" IS NULL OR "reviewer_id" <> "user_id")
);
CREATE INDEX "kyc_cases_status_submitted_at_idx" ON "kyc_cases"("status", "submitted_at");
CREATE INDEX "kyc_cases_user_id_idx" ON "kyc_cases"("user_id");
-- At most one open case per user.
CREATE UNIQUE INDEX "kyc_cases_one_open_per_user" ON "kyc_cases"("user_id") WHERE "status" IN ('PENDING', 'NEEDS_INFO');
ALTER TABLE "kyc_cases" ADD CONSTRAINT "kyc_cases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "kyc_cases" ADD CONSTRAINT "kyc_cases_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "notifications" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "kind" VARCHAR(48) NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "body" VARCHAR(1000) NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "read_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "support_tickets" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "subject" VARCHAR(160) NOT NULL,
  "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_tickets_status_updated_at_idx" ON "support_tickets"("status", "updated_at");
CREATE INDEX "support_tickets_user_id_idx" ON "support_tickets"("user_id");
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "support_messages" (
  "id" UUID NOT NULL,
  "ticket_id" UUID NOT NULL,
  "author_id" UUID NOT NULL,
  "from_staff" BOOLEAN NOT NULL,
  "body" VARCHAR(5000) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_messages_ticket_id_created_at_idx" ON "support_messages"("ticket_id", "created_at");
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "announcements" (
  "id" UUID NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "body" VARCHAR(5000) NOT NULL,
  "created_by_id" UUID NOT NULL,
  "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "announcements_published_at_idx" ON "announcements"("published_at");
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Support messages and announcements are records: append-only.
CREATE TRIGGER support_messages_immutable BEFORE UPDATE OR DELETE ON "support_messages"
  FOR EACH ROW EXECUTE FUNCTION perp_history_immutable();
CREATE TRIGGER announcements_immutable BEFORE UPDATE OR DELETE ON "announcements"
  FOR EACH ROW EXECUTE FUNCTION perp_history_immutable();
