-- Cross-margin mode (ADR-0021): free balance automatically backs positions.
ALTER TABLE "users" ADD COLUMN "perp_margin_mode" VARCHAR(8) NOT NULL DEFAULT 'isolated';
ALTER TABLE "users" ADD CONSTRAINT "users_perp_margin_mode_chk" CHECK ("perp_margin_mode" IN ('isolated', 'cross'));
