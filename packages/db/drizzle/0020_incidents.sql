CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"source" text,
	"ticket_id" uuid,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_open_uq" ON "incidents" USING btree ("integration_id","fingerprint") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "incidents_integration_idx" ON "incidents" USING btree ("integration_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "incidents_ticket_idx" ON "incidents" USING btree ("ticket_id");