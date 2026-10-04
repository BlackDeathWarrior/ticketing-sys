ALTER TABLE "voice_calls" ADD COLUMN "provider_attempt_id" text;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "requested_by" text;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "about" text;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_calls_attempt_idx" ON "voice_calls" USING btree ("provider_attempt_id");