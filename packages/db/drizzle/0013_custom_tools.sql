ALTER TABLE "mcp_servers" ADD COLUMN "kind" text DEFAULT 'mcp' NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "http" jsonb;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;