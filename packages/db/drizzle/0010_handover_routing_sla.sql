CREATE TABLE "agent_presence" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"capacity" integer DEFAULT 5 NOT NULL,
	"last_routed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"schedule" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"conversation_id" uuid,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"rules" text[] DEFAULT '{}' NOT NULL,
	"pack" jsonb,
	"pack_status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid,
	"routed_team_id" uuid,
	"routed_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_hours_id" uuid NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"ticket_id" uuid,
	"dedupe_key" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"team_id" uuid NOT NULL,
	"strategy" text DEFAULT 'least_loaded' NOT NULL,
	"required_skill" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"priority" text,
	"customer_type" text,
	"first_response_minutes" integer NOT NULL,
	"resolution_minutes" integer NOT NULL,
	"business_hours_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_timers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"policy_id" uuid,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"target_minutes" integer NOT NULL,
	"consumed_minutes" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"resumed_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"at_risk_at" timestamp with time zone,
	"at_risk_notified" boolean DEFAULT false NOT NULL,
	"met_at" timestamp with time zone,
	"breached_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_skills" (
	"user_id" uuid NOT NULL,
	"skill" text NOT NULL,
	CONSTRAINT "user_skills_user_id_skill_pk" PRIMARY KEY("user_id","skill")
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "sla_state" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "sla_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "handling" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_presence" ADD CONSTRAINT "agent_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_routed_team_id_teams_id_fk" FOREIGN KEY ("routed_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_routed_user_id_users_id_fk" FOREIGN KEY ("routed_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_business_hours_id_business_hours_id_fk" FOREIGN KEY ("business_hours_id") REFERENCES "public"."business_hours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_business_hours_id_business_hours_id_fk" FOREIGN KEY ("business_hours_id") REFERENCES "public"."business_hours"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_timers" ADD CONSTRAINT "sla_timers_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_timers" ADD CONSTRAINT "sla_timers_policy_id_sla_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handovers_ticket_idx" ON "handovers" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "holidays_day_idx" ON "holidays" USING btree ("business_hours_id","date");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_idx" ON "notifications" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_timers_ticket_kind_idx" ON "sla_timers" USING btree ("ticket_id","kind");--> statement-breakpoint
CREATE INDEX "sla_timers_due_idx" ON "sla_timers" USING btree ("state","due_at");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_sla_policy_id_sla_policies_id_fk" FOREIGN KEY ("sla_policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tickets_sla_idx" ON "tickets" USING btree ("sla_state","sla_due_at");--> statement-breakpoint
CREATE INDEX "tickets_handling_idx" ON "tickets" USING btree ("handling");--> statement-breakpoint
-- Who is answering existing tickets, from their conversations.
UPDATE "tickets" t SET "handling" = CASE
  WHEN EXISTS (SELECT 1 FROM "conversations" c WHERE c."ticket_id" = t."id" AND c."controller" = 'ai') THEN 'ai'
  WHEN EXISTS (SELECT 1 FROM "conversations" c WHERE c."ticket_id" = t."id" AND c."controller" = 'human') THEN 'human'
  ELSE 'none'
END;
