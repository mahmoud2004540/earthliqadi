-- The web app is English-only (ADR-0008); the per-user UI language preference is no longer used.
ALTER TABLE "users" DROP COLUMN "locale";
