ALTER TABLE "organization" ADD COLUMN "inbound_trigger_gate" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN "token_created_at" timestamp;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN "token_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN "token_notice" text;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN "last_used_at" timestamp;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN "last_rejected_at" timestamp;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "inbound_triggers_allowed" boolean DEFAULT false NOT NULL;