-- Step-up re-authentication (ADR-0015): when this session last proved a fresh authenticator code.
ALTER TABLE "sessions" ADD COLUMN "step_up_at" TIMESTAMPTZ(3);
