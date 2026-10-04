ALTER TABLE "team_members" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "approver_team_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_approver_team_id_teams_id_fk" FOREIGN KEY ("approver_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;