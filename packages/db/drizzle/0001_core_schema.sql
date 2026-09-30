CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_pk" PRIMARY KEY("role_id","permission")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"primary_email" text,
	"primary_phone" text,
	"language" text,
	"customer_type" text DEFAULT 'standard' NOT NULL,
	"external_ref" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_statuses" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"is_initial" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" bigserial NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"subject" text NOT NULL,
	"description" text,
	"category_id" uuid,
	"subcategory_id" uuid,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text NOT NULL,
	"sla_policy_id" uuid,
	"team_id" uuid,
	"assignee_id" uuid,
	"resolution" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_response_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "workflow_transitions" (
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	CONSTRAINT "workflow_transitions_from_status_to_status_pk" PRIMARY KEY("from_status","to_status")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"external_thread_id" text,
	"controller" text DEFAULT 'none' NOT NULL,
	"controller_user_id" uuid,
	"state" text DEFAULT 'open' NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"author_type" text NOT NULL,
	"author_user_id" uuid,
	"body" text DEFAULT '' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"channel_message_id" text,
	"delivery_status" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "outbox_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_identities" ADD CONSTRAINT "customer_identities_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_merged_into_id_customers_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_subcategory_id_categories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_status_ticket_statuses_key_fk" FOREIGN KEY ("status") REFERENCES "public"."ticket_statuses"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_from_status_ticket_statuses_key_fk" FOREIGN KEY ("from_status") REFERENCES "public"."ticket_statuses"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_to_status_ticket_statuses_key_fk" FOREIGN KEY ("to_status") REFERENCES "public"."ticket_statuses"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_controller_user_id_users_id_fk" FOREIGN KEY ("controller_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "team_members_user_idx" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "customer_identities_type_value_uq" ON "customer_identities" USING btree ("type","value");--> statement-breakpoint
CREATE INDEX "customer_identities_customer_idx" ON "customer_identities" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customers_display_name_trgm" ON "customers" USING gin ("display_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_primary_email_idx" ON "customers" USING btree ("primary_email");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_parent_name_uq" ON "categories" USING btree (coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE INDEX "internal_notes_ticket_idx" ON "internal_notes" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tickets_assignee_idx" ON "tickets" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "tickets_team_idx" ON "tickets" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "tickets_customer_idx" ON "tickets" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "tickets_created_idx" ON "tickets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tickets_tags_gin" ON "tickets" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "tickets_subject_trgm" ON "tickets" USING gin ("subject" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "conversations_ticket_idx" ON "conversations" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "conversations_thread_idx" ON "conversations" USING btree ("channel","external_thread_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_msg_uq" ON "messages" USING btree ("channel","channel_message_id");--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_log" USING btree ("target_type","target_id","id");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id","id");--> statement-breakpoint
CREATE INDEX "audit_occurred_idx" ON "audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox_events" USING btree ("id") WHERE published_at IS NULL;