-- Inbound Triggers (ADR-0030). Generated on the feature branch as 0076 and
-- renumbered to 0079 when 0076-0078 merged to main first.
--
-- A database that ran the branch build already has these columns under the old
-- 0076 entry. Drizzle's migrator applies main's 0076-0078 there (their `when`
-- is later) and then this file, so every statement is idempotent; a fresh
-- database applies it normally. See 0068 for the same pattern.
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "inbound_trigger_gate" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN IF NOT EXISTS "token_hash" text;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN IF NOT EXISTS "token_created_at" timestamp;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN IF NOT EXISTS "token_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN IF NOT EXISTS "token_notice" text;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN IF NOT EXISTS "last_rejected_at" timestamp;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "inbound_triggers_allowed" boolean DEFAULT false NOT NULL;
