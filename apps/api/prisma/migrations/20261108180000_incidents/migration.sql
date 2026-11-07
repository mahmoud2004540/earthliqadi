-- Public status page and incident reports (ADR-0030).
CREATE TABLE "incidents" (
  "id"          UUID NOT NULL,
  "title"       VARCHAR(160) NOT NULL,
  "impact"      VARCHAR(10) NOT NULL,
  "status"      VARCHAR(14) NOT NULL,
  "created_by"  UUID NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "started_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(3),
  CONSTRAINT "incidents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "incidents_chk" CHECK (
    "impact" IN ('minor', 'major', 'critical')
    AND "status" IN ('investigating', 'identified', 'monitoring', 'resolved')
    AND (("status" = 'resolved') = ("resolved_at" IS NOT NULL)))
);
CREATE INDEX "incidents_started_idx" ON "incidents" ("started_at");

-- Updates are append-only: what was published stays published.
CREATE TABLE "incident_updates" (
  "id"          UUID NOT NULL,
  "incident_id" UUID NOT NULL REFERENCES "incidents" ("id") ON DELETE RESTRICT,
  "status"      VARCHAR(14) NOT NULL,
  "body"        VARCHAR(2000) NOT NULL,
  "created_by"  UUID NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "incident_updates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "incident_updates_chk" CHECK ("status" IN ('investigating', 'identified', 'monitoring', 'resolved'))
);
CREATE INDEX "incident_updates_incident_idx" ON "incident_updates" ("incident_id", "created_at");
CREATE FUNCTION "incident_updates_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'incident updates are append-only';
END $$;
CREATE TRIGGER "incident_updates_no_change" BEFORE UPDATE OR DELETE ON "incident_updates"
  FOR EACH ROW EXECUTE FUNCTION "incident_updates_append_only"();
