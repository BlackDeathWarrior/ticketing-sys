ALTER TABLE "conversations" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivery_error" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sent_at" timestamp with time zone;