CREATE TABLE "kb_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"team_id" uuid,
	"auto_approve" boolean DEFAULT false NOT NULL,
	"schedule_minutes" integer DEFAULT 1440 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"stats" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "kb_connectors" ADD CONSTRAINT "kb_connectors_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_connectors" ADD CONSTRAINT "kb_connectors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_connector_id_kb_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."kb_connectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_documents_connector_item_uq" ON "kb_documents" USING btree ("connector_id","external_id");