CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"model_id" uuid,
	"provider_id" uuid,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"fallbacks_attempted" integer DEFAULT 0 NOT NULL,
	"error" text,
	"ticket_id" uuid,
	"conversation_id" uuid,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"model" text NOT NULL,
	"label" text NOT NULL,
	"mode" text DEFAULT 'chat' NOT NULL,
	"supports_tools" boolean DEFAULT false NOT NULL,
	"supports_json" boolean DEFAULT false NOT NULL,
	"supports_vision" boolean DEFAULT false NOT NULL,
	"context_window" integer,
	"input_cost_per_token" double precision,
	"output_cost_per_token" double precision,
	"cost_source" text DEFAULT 'unknown' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text,
	"key_last4" text,
	"litellm_credential" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"budget_usd" double precision,
	"budget_period" text DEFAULT 'month' NOT NULL,
	"last_test" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_providers_litellm_credential_unique" UNIQUE("litellm_credential")
);
--> statement-breakpoint
CREATE TABLE "llm_roles" (
	"role" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'cheapest' NOT NULL,
	"model_ids" uuid[] DEFAULT '{}' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"last4" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_model_id_llm_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."llm_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_provider_id_llm_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_models" ADD CONSTRAINT "llm_models_provider_id_llm_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_roles" ADD CONSTRAINT "llm_roles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_calls_provider_created_idx" ON "llm_calls" USING btree ("provider_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_created_idx" ON "llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "llm_models_provider_idx" ON "llm_models" USING btree ("provider_id");