ALTER TABLE "tickets" ADD COLUMN "integration_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tickets_integration_idx" ON "tickets" USING btree ("integration_id","external_ref");