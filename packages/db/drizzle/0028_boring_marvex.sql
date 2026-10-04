ALTER TABLE "voice_calls" ADD COLUMN "transport" text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "direction" text DEFAULT 'inbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "provider_call_id" text;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "caller_phone" text;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "handover_reason" text;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "tool_call_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "imported_turns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_calls_provider_call_idx" ON "voice_calls" USING btree ("provider_call_id");